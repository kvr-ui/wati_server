import { getDb } from './mongodb'
import { sendVslReminder, sessionWindowRemainingMs } from './wati'

function num(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

// Hour of day in Asia/Kolkata — the timezone already used for the Bigin notes in lib/bigin.ts.
export function istHour(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '12')
}

function inQuietHours(now: Date) {
  const start = num('VSL_REMINDER_QUIET_START_IST', 21)
  const end = num('VSL_REMINDER_QUIET_END_IST', 9)
  const hour = istHour(now)
  // The window wraps midnight, so "quiet" is outside [end, start).
  return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

const MAX_REMINDER_ATTEMPTS = 3

export type ReminderBatchResult = {
  skipped?: string
  dryRun: boolean
  candidates: number
  claimed: number
  sent: number
  cancelled: number
  failed: number
  leads: { phone: string; leadId: string; outcome: string }[]
}

// Sends at most one reminder per lead, ever. Every state transition is a filtered atomic
// update, so a second concurrent run (or a duplicated cron tick) cannot double-send.
export async function runVslReminderBatch(options: { dryRun?: boolean } = {}): Promise<ReminderBatchResult> {
  const dryRun = Boolean(options.dryRun)
  const result: ReminderBatchResult = { dryRun, candidates: 0, claimed: 0, sent: 0, cancelled: 0, failed: 0, leads: [] }

  if (!dryRun && process.env.VSL_REMINDERS_ENABLED !== 'true') {
    return { ...result, skipped: 'VSL_REMINDERS_ENABLED is not true' }
  }

  const now = new Date()
  if (!dryRun && inQuietHours(now)) {
    // No state change needed — reminderDueAt is already in the past, so these simply go out
    // on the first run after quiet hours end.
    return { ...result, skipped: 'quiet hours (Asia/Kolkata)' }
  }

  const db = await getDb()
  const leads = db.collection('vsl_leads')

  // The field that proves engagement, and so disqualifies a lead from being chased.
  // 'play' (default) => they must have pressed play; 'open' => loading the page is enough.
  const engagedField = (process.env.VSL_REMINDER_CANCEL_ON || 'play') === 'open' ? 'firstOpenedAt' : 'firstPlayAt'

  const due = {
    reminderState: 'due',
    reminderDueAt: { $lte: now },
    [engagedField]: { $exists: false },
    reminderSentAt: { $exists: false },
  }

  result.candidates = await leads.countDocuments(due)

  // Circuit breaker: a backfill that wrongly stamped reminderDueAt on historical leads would
  // show up here as a huge candidate count. Refuse to message anyone until a human looks.
  const maxCandidates = num('VSL_REMINDER_MAX_CANDIDATES', 200)
  if (result.candidates > maxCandidates) {
    console.error(`VSL reminders aborted: ${result.candidates} candidates exceeds VSL_REMINDER_MAX_CANDIDATES=${maxCandidates}`)
    return { ...result, skipped: `candidate count ${result.candidates} exceeds cap ${maxCandidates}` }
  }

  if (dryRun) {
    const preview = await leads.find(due).sort({ reminderDueAt: 1 }).limit(num('VSL_REMINDER_BATCH', 25)).toArray()
    result.leads = preview.map((l) => ({ phone: String(l.phone), leadId: String(l.leadId), outcome: 'would-send' }))
    return result
  }

  const batch = num('VSL_REMINDER_BATCH', 25)
  const gapMs = num('VSL_REMINDER_SEND_GAP_MS', 400)

  for (let i = 0; i < batch; i++) {
    // Claim one lead atomically. Never find() then update — that double-sends across workers.
    const lead = await leads.findOneAndUpdate(
      due,
      { $set: { reminderState: 'claimed', reminderClaimedAt: new Date() }, $inc: { reminderAttempts: 1 } },
      { sort: { reminderDueAt: 1 }, returnDocument: 'after' },
    )
    if (!lead) break
    result.claimed++

    // Close the claim-to-send race: the lead may have engaged in the last few milliseconds,
    // in which case the cancel update could not match 'claimed'.
    const fresh = await leads.findOne({ _id: lead._id }, { projection: { [engagedField]: 1 } })
    if (fresh?.[engagedField]) {
      await leads.updateOne(
        { _id: lead._id, reminderState: 'claimed' },
        { $set: { reminderState: 'cancelled', reminderCancelledAt: new Date() } },
      )
      result.cancelled++
      result.leads.push({ phone: String(lead.phone), leadId: String(lead.leadId), outcome: 'cancelled-engaged' })
      continue
    }

    // The 24h window runs from the lead's last INBOUND message, not from our send, so verify
    // it is genuinely still open rather than trusting reminderDueAt arithmetic. A lead who
    // replied again since has extended their own window; one whose window closed would only
    // get a rejected send.
    const remainingMs = await sessionWindowRemainingMs(String(lead.phone))
    if (remainingMs !== undefined && remainingMs <= 0 && !process.env.WATI_REMINDER_TEMPLATE_NAME) {
      await leads.updateOne(
        { _id: lead._id, reminderState: 'claimed' },
        { $set: { reminderState: 'window_closed', reminderError: 'session window closed and no fallback template configured' } },
      )
      result.failed++
      result.leads.push({ phone: String(lead.phone), leadId: String(lead.leadId), outcome: 'window-closed' })
      if (gapMs > 0 && i < batch - 1) await new Promise((r) => setTimeout(r, gapMs))
      continue
    }

    const outcome = await sendVslReminder(String(lead.phone), String(lead.name || ''))

    if (outcome.ok) {
      await leads.updateOne(
        { _id: lead._id, reminderState: 'claimed' },
        { $set: { reminderState: 'sent', reminderSentAt: new Date() } },
      )
      result.sent++
      result.leads.push({ phone: String(lead.phone), leadId: String(lead.leadId), outcome: 'sent' })
    } else if (outcome.definitive && Number(lead.reminderAttempts || 0) < MAX_REMINDER_ATTEMPTS) {
      // Known not delivered and attempts remain — return it to the queue for the next tick.
      await leads.updateOne(
        { _id: lead._id, reminderState: 'claimed' },
        { $set: { reminderState: 'due', reminderError: outcome.error }, $unset: { reminderClaimedAt: '' } },
      )
      result.failed++
      result.leads.push({ phone: String(lead.phone), leadId: String(lead.leadId), outcome: 'retry' })
    } else {
      // Either out of attempts, or ambiguous — a duplicate reminder is worse than a missed
      // one, so it is parked rather than retried.
      await leads.updateOne(
        { _id: lead._id, reminderState: 'claimed' },
        { $set: { reminderState: outcome.definitive ? 'failed' : 'unknown', reminderError: outcome.error } },
      )
      result.failed++
      result.leads.push({ phone: String(lead.phone), leadId: String(lead.leadId), outcome: outcome.definitive ? 'failed' : 'unknown' })
    }

    if (gapMs > 0 && i < batch - 1) await new Promise((r) => setTimeout(r, gapMs))
  }

  return result
}

// Claims stranded by a crash between claim and finalise. Auto-reclaiming risks a duplicate
// (the send may have succeeded first), so by default they are parked for review.
export async function sweepStaleReminderClaims() {
  const db = await getDb()
  const cutoff = new Date(Date.now() - num('VSL_REMINDER_STALE_MINUTES', 15) * 60_000)
  const target = process.env.VSL_REMINDER_RECLAIM_STALE === 'true' ? 'due' : 'stuck'
  const res = await db.collection('vsl_leads').updateMany(
    { reminderState: 'claimed', reminderClaimedAt: { $lt: cutoff } },
    { $set: { reminderState: target } },
  )
  return { movedTo: target, count: res.modifiedCount }
}
