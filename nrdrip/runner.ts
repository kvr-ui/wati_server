import { getDb } from '@/lib/mongodb'
import { istHour } from '@/lib/vslReminders'
import { getLastInboundAt } from '@/lib/wati'
import {
  COLLECTION,
  MAX_STEP_ATTEMPTS,
  batchSize,
  dueAtForStep,
  enabled,
  maxCandidates,
  quietEndIst,
  quietStartIst,
  reclaimStale,
  sendGapMs,
  staleClaimMs,
} from './config'
import { sendNrDripStep } from './send'
import type { NrDripBatchResult, NrDripDoc } from './types'

function inQuietHours(now: Date) {
  const start = quietStartIst()
  const end = quietEndIst()
  const hour = istHour(now)
  // The window wraps midnight, so "quiet" is outside [end, start).
  return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

// Whether the lead has said anything since we enrolled them. Any reply means a human is
// engaged and the drip has done its job — sales takes it from here.
//
// The comparison is against enrolledAt, not "has ever messaged us": every lead in this
// collection already talked to the onboarding bot, so an all-time check would cancel everyone.
async function hasRepliedSinceEnrolment(phone: string, enrolledAt: Date) {
  // getLastInboundAt answers `now` under WATI_DRY_RUN to keep local runs hermetic, which would
  // read as "everyone just replied" and cancel the whole batch. Dry runs skip the check.
  if (process.env.WATI_DRY_RUN === 'true') return false
  const lastInbound = await getLastInboundAt(phone)
  return Boolean(lastInbound && lastInbound.getTime() > enrolledAt.getTime())
}

// Sends at most one step per lead per run. Every state transition is a filtered atomic update,
// so a second concurrent run (or a duplicated cron tick) cannot double-send.
export async function runNrDripBatch(options: { dryRun?: boolean } = {}): Promise<NrDripBatchResult> {
  const dryRun = Boolean(options.dryRun)
  const result: NrDripBatchResult = { dryRun, candidates: 0, claimed: 0, sent: 0, completed: 0, cancelled: 0, failed: 0, leads: [] }

  if (!dryRun && !enabled()) {
    return { ...result, skipped: 'NR_DRIP_ENABLED is not true' }
  }

  const now = new Date()
  if (!dryRun && inQuietHours(now)) {
    // No state change needed — dueAt is already in the past, so these simply go out on the
    // first run after quiet hours end.
    return { ...result, skipped: 'quiet hours (Asia/Kolkata)' }
  }

  const db = await getDb()
  // Typed so $push against `steps` is checked rather than degraded to a bare Document.
  const drips = db.collection<NrDripDoc>(COLLECTION)

  const due = { state: 'due' as const, dueAt: { $lte: now } }

  result.candidates = await drips.countDocuments(due)

  // Circuit breaker: a bad import or a backfill that wrongly stamped dueAt would show up here
  // as a huge candidate count. Refuse to message anyone until a human looks.
  const cap = maxCandidates()
  if (result.candidates > cap) {
    console.error(`NR drip aborted: ${result.candidates} candidates exceeds NR_DRIP_MAX_CANDIDATES=${cap}`)
    return { ...result, skipped: `candidate count ${result.candidates} exceeds cap ${cap}` }
  }

  const batch = batchSize()

  if (dryRun) {
    const preview = await drips.find(due).sort({ dueAt: 1 }).limit(batch).toArray()
    result.leads = preview.map((d) => ({ phone: String(d.phone), step: Number(d.step ?? 0), outcome: 'would-send' }))
    return result
  }

  const gapMs = sendGapMs()

  for (let i = 0; i < batch; i++) {
    // Claim one lead atomically. Never find() then update — that double-sends across workers.
    const lead = await drips.findOneAndUpdate(
      due,
      { $set: { state: 'claimed', claimedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { dueAt: 1 }, returnDocument: 'after' },
    )
    if (!lead) break
    result.claimed++

    const phone = String(lead.phone)
    const name = String(lead.name || '')
    const step = Number(lead.step ?? 0)
    const enrolledAt = lead.enrolledAt instanceof Date ? lead.enrolledAt : new Date(0)

    if (await hasRepliedSinceEnrolment(phone, enrolledAt)) {
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        { $set: { state: 'cancelled', cancelledAt: new Date(), cancelReason: 'replied' }, $unset: { claimedAt: '' } },
      )
      result.cancelled++
      result.leads.push({ phone, step, outcome: 'cancelled-replied' })
      continue
    }

    const outcome = await sendNrDripStep(phone, name, step)

    if (outcome.ok) {
      const nextStep = step + 1
      const nextDueAt = dueAtForStep(enrolledAt, nextStep)
      const sentAt = new Date()
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        {
          $set: nextDueAt
            // attempts counts CONSECUTIVE failures on the current step, so a success clears it.
            ? { state: 'due', step: nextStep, dueAt: nextDueAt, attempts: 0 }
            : { state: 'completed', completedAt: sentAt, attempts: 0 },
          $push: { steps: { index: step, sentAt, channel: outcome.channel } },
          $unset: { claimedAt: '', lastError: '' },
        },
      )
      result.sent++
      if (!nextDueAt) result.completed++
      result.leads.push({ phone, step, outcome: nextDueAt ? `sent-${outcome.channel}` : `sent-${outcome.channel}-completed` })
    } else if (outcome.windowClosed) {
      // Retrying cannot help: the window will not reopen unless the lead writes to us, and
      // if they do, the drip is cancelled anyway. Park it for whoever configures templates.
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        { $set: { state: 'window_closed', lastError: outcome.error }, $unset: { claimedAt: '' } },
      )
      result.failed++
      result.leads.push({ phone, step, outcome: 'window-closed' })
    } else if (outcome.definitive && Number(lead.attempts || 0) < MAX_STEP_ATTEMPTS) {
      // Known not delivered and attempts remain — return it to the queue for the next tick.
      // dueAt is untouched and already past, so it is picked up immediately.
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        { $set: { state: 'due', lastError: outcome.error }, $unset: { claimedAt: '' } },
      )
      result.failed++
      result.leads.push({ phone, step, outcome: 'retry' })
    } else {
      // Either out of attempts, or ambiguous — a duplicate WhatsApp message is worse than a
      // missed one, so it is parked rather than retried.
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        { $set: { state: outcome.definitive ? 'failed' : 'unknown', lastError: outcome.error }, $unset: { claimedAt: '' } },
      )
      result.failed++
      result.leads.push({ phone, step, outcome: outcome.definitive ? 'failed' : 'unknown' })
    }

    if (gapMs > 0 && i < batch - 1) await new Promise((r) => setTimeout(r, gapMs))
  }

  return result
}

// Claims stranded by a crash between claim and finalise. Auto-reclaiming risks a duplicate
// (the send may have succeeded first), so by default they are parked for review.
export async function sweepStaleNrDripClaims() {
  const db = await getDb()
  const cutoff = new Date(Date.now() - staleClaimMs())
  const target = reclaimStale() ? 'due' : 'stuck'
  const res = await db.collection(COLLECTION).updateMany(
    { state: 'claimed', claimedAt: { $lt: cutoff } },
    { $set: { state: target } },
  )
  return { movedTo: target, count: res.modifiedCount }
}
