import type { Collection, Document } from 'mongodb'
import { getDb } from './mongodb'
import { istHour } from './vslReminders'
import { onboardingDelayMs, tapCheckMs } from './vslSend'
import { getLastInboundAt, sendOnboardingTemplate, sessionWindowRemainingMs, startChatbot, type SendOutcome } from './wati'

function num(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

function inQuietHours(now: Date) {
  const start = num('ONBOARDING_BOT_QUIET_START_IST', 21)
  const end = num('ONBOARDING_BOT_QUIET_END_IST', 9)
  // Equal start and end means quiet hours are OFF — the convention the drip campaigns use.
  if (start === end) return false
  const hour = istHour(now)
  // The window wraps midnight, so "quiet" is outside [end, start).
  return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

const MAX_TRIGGER_ATTEMPTS = 3

export type OnboardingChannel = 'chatbot_api' | 'template'

export type OnboardingBatchResult = {
  skipped?: string
  dryRun: boolean
  checked: number
  tapped: number
  expired: number
  candidates: number
  claimed: number
  sent: number
  windowClosed: number
  failed: number
  leads: { phone: string; leadId: string; outcome: string }[]
}

// Starts the onboarding bot for one lead.
//
// The bot is NOT a template. It is a WATI chatbot flow that fires on the "Confirm" keyword, so
// there are only two ways in:
//
//   chatbots/start  — begins the flow with no action from the lead, but its first message is
//                     free-form, so it only lands inside the 24h window.
//   Confirm template — reaches a lead whose window has closed; they tap Confirm, and the keyword
//                     starts the flow inside WATI.
//
// Only the first is configured today: WATI_ONBOARDING_TEMPLATE_NAME is deliberately empty, so a
// lead whose window has closed is SKIPPED rather than messaged. Setting that key later turns the
// template path back on with no code change.
//
// The window is checked HERE rather than trusted from the API's answer: chatbots/start reports
// result:true for "flow started", not for "message delivered", so a call against a closed window
// looks like a success while the lead receives nothing — and still burns a billable chatbot
// session. An unknown window (undefined) is therefore treated as closed. That is the opposite of
// dripcore/send.ts, which may assume "open" precisely because a session send that is wrong about
// it fails loudly and falls back on its own. Here the failure would be invisible.
export async function triggerOnboardingBot(
  phone: string,
  name: string,
): Promise<(SendOutcome & { channel?: OnboardingChannel }) | { ok: false; windowClosed: true; reason: string }> {
  const template = process.env.WATI_ONBOARDING_TEMPLATE_NAME
  const remainingMs = process.env.WATI_CHATBOT_ID ? await sessionWindowRemainingMs(phone) : undefined

  if (remainingMs !== undefined && remainingMs > 0) {
    const started = await startChatbot(phone)
    if (started.ok) return { ...started, channel: 'chatbot_api' }
    if (!template) return started
    console.warn('chatbot start failed, falling back to the Confirm template', started.error)
  }

  // Nothing can reach this lead: their window is shut and there is no approved template to open
  // it. Retrying cannot help — only the lead writing to us would change the answer — so this is
  // reported as a skip, and the runner parks them without burning attempts or logging an error.
  if (!template) {
    return { ok: false, windowClosed: true, reason: 'session window closed and no Confirm template is configured' }
  }

  const outcome = await sendOnboardingTemplate(phone, name)
  return outcome.ok ? { ...outcome, channel: 'template' } : outcome
}

// Phase one: find out who has tapped the button in the VSL template.
//
// vsl_final is a greeting with a button. WATI sends the tracked link only once the lead taps it,
// and that same tap is the lead's first INBOUND message — which is what opens the 24h window. So
// the tap is both the moment the link reaches them and the moment the chatbot API becomes usable,
// and it is what the one-hour clock is counted from.
//
// There is no WATI webhook for incoming messages, so this polls: any inbound later than our send
// is the tap. A lead who never taps is dropped at the deadline rather than polled forever.
async function watchForTaps(
  leads: Collection<Document>,
  now: Date,
  result: OnboardingBatchResult,
) {
  const batch = num('ONBOARDING_BOT_TAP_BATCH', 50)

  for (let i = 0; i < batch; i++) {
    // Pushing onboardingCheckAt forward IS the claim: a second worker in the same tick will not
    // see this lead, so nobody is looked up at WATI twice.
    const lead = await leads.findOneAndUpdate(
      { onboardingState: 'waiting', onboardingCheckAt: { $lte: now } },
      { $set: { onboardingCheckAt: new Date(Date.now() + tapCheckMs()) } },
      { sort: { onboardingCheckAt: 1 }, returnDocument: 'after' },
    )
    if (!lead) break
    result.checked++

    const phone = String(lead.phone)
    const linkSentAt = lead.linkSentAt instanceof Date ? lead.linkSentAt : new Date(0)
    const lastInbound = await getLastInboundAt(phone)

    if (lastInbound && lastInbound.getTime() > linkSentAt.getTime()) {
      // Tapped. The window is open from this moment, so the bot is scheduled an hour on and will
      // still be inside it.
      await leads.updateOne(
        { _id: lead._id, onboardingState: 'waiting' },
        {
          $set: {
            onboardingState: 'due',
            onboardingTappedAt: lastInbound,
            onboardingDueAt: new Date(lastInbound.getTime() + onboardingDelayMs()),
          },
          $unset: { onboardingCheckAt: '' },
        },
      )
      result.tapped++
      result.leads.push({ phone, leadId: String(lead.leadId), outcome: 'tapped' })
      continue
    }

    const deadline = lead.onboardingDeadlineAt instanceof Date ? lead.onboardingDeadlineAt : undefined
    if (deadline && now.getTime() > deadline.getTime()) {
      // Never tapped, so the link never reached them and their window never opened. Terminal:
      // there is nothing this job can do for them.
      await leads.updateOne(
        { _id: lead._id, onboardingState: 'waiting' },
        { $set: { onboardingState: 'no_tap', onboardingSkippedAt: now }, $unset: { onboardingCheckAt: '' } },
      )
      result.expired++
      result.leads.push({ phone, leadId: String(lead.leadId), outcome: 'expired-no-tap' })
    }
  }
}

// Phase two: triggers the bot for every lead whose hour is up. At most one trigger per lead, ever: every
// state transition is a filtered atomic update, so a second concurrent run (or a duplicated cron
// tick) cannot double-send.
//
// Deliberately unconditional otherwise — no reply check and no completion check. A lead who
// already typed Confirm and walked through the bot on their own still gets this. Gating it later
// is one extra clause in `due` (firstPlayAt for watched-only, or a getLastInboundAt check for
// replied-only).
export async function runOnboardingBotBatch(options: { dryRun?: boolean } = {}): Promise<OnboardingBatchResult> {
  const dryRun = Boolean(options.dryRun)
  const result: OnboardingBatchResult = { dryRun, checked: 0, tapped: 0, expired: 0, candidates: 0, claimed: 0, sent: 0, windowClosed: 0, failed: 0, leads: [] }

  if (!dryRun && process.env.ONBOARDING_BOT_ENABLED !== 'true') {
    return { ...result, skipped: 'ONBOARDING_BOT_ENABLED is not true' }
  }

  // With neither way in configured, every lead would be marked skipped — a config gap should stop
  // the job, not quietly consume the whole queue.
  if (!dryRun && !process.env.WATI_CHATBOT_ID && !process.env.WATI_ONBOARDING_TEMPLATE_NAME) {
    return { ...result, skipped: 'neither WATI_CHATBOT_ID nor WATI_ONBOARDING_TEMPLATE_NAME is configured' }
  }

  const now = new Date()
  if (!dryRun && inQuietHours(now)) {
    // No state change needed — onboardingDueAt is already in the past, so these simply go out on
    // the first run after quiet hours end.
    return { ...result, skipped: 'quiet hours (Asia/Kolkata)' }
  }

  const db = await getDb()
  const leads = db.collection('vsl_leads')

  if (!dryRun) await watchForTaps(leads, now, result)

  const due = {
    onboardingState: 'due',
    onboardingDueAt: { $lte: now },
    onboardingSentAt: { $exists: false },
  }

  result.candidates = await leads.countDocuments(due)

  // Circuit breaker: a backfill that wrongly stamped onboardingDueAt on historical leads would
  // show up here as a huge candidate count. Refuse to message anyone until a human looks.
  const maxCandidates = num('ONBOARDING_BOT_MAX_CANDIDATES', 200)
  if (result.candidates > maxCandidates) {
    console.error(`Onboarding bot aborted: ${result.candidates} candidates exceeds ONBOARDING_BOT_MAX_CANDIDATES=${maxCandidates}`)
    return { ...result, skipped: `candidate count ${result.candidates} exceeds cap ${maxCandidates}` }
  }

  const batch = num('ONBOARDING_BOT_BATCH', 25)

  if (dryRun) {
    const preview = await leads.find(due).sort({ onboardingDueAt: 1 }).limit(batch).toArray()
    result.leads = preview.map((l) => ({ phone: String(l.phone), leadId: String(l.leadId), outcome: 'would-send' }))
    return result
  }

  const gapMs = num('ONBOARDING_BOT_SEND_GAP_MS', 400)
  const backoffMs = num('ONBOARDING_BOT_RETRY_BACKOFF_MINUTES', 15) * 60_000

  for (let i = 0; i < batch; i++) {
    // Claim one lead atomically. Never find() then update — that double-sends across workers.
    const lead = await leads.findOneAndUpdate(
      due,
      { $set: { onboardingState: 'claimed', onboardingClaimedAt: new Date() }, $inc: { onboardingAttempts: 1 } },
      { sort: { onboardingDueAt: 1 }, returnDocument: 'after' },
    )
    if (!lead) break
    result.claimed++

    const phone = String(lead.phone)
    const outcome = await triggerOnboardingBot(phone, String(lead.name || ''))

    if (!outcome.ok && 'windowClosed' in outcome) {
      // Terminal, and not an error: nothing could have reached them. Parked so the queue does not
      // re-examine them on every tick.
      await leads.updateOne(
        { _id: lead._id, onboardingState: 'claimed' },
        { $set: { onboardingState: 'window_closed', onboardingSkippedAt: new Date(), onboardingError: outcome.reason }, $unset: { onboardingClaimedAt: '' } },
      )
      result.windowClosed++
      result.leads.push({ phone, leadId: String(lead.leadId), outcome: 'skipped-window-closed' })
      if (gapMs > 0 && i < batch - 1) await new Promise((r) => setTimeout(r, gapMs))
      continue
    }

    if (outcome.ok) {
      await leads.updateOne(
        { _id: lead._id, onboardingState: 'claimed' },
        { $set: { onboardingState: 'sent', onboardingSentAt: new Date(), onboardingChannel: outcome.channel }, $unset: { onboardingClaimedAt: '' } },
      )
      result.sent++
      result.leads.push({ phone, leadId: String(lead.leadId), outcome: `sent-${outcome.channel}` })
    } else if (outcome.definitive && Number(lead.onboardingAttempts || 0) < MAX_TRIGGER_ATTEMPTS) {
      // Known not delivered and attempts remain, so it goes back on the queue — but onboardingDueAt
      // has to move forward. Left in the past, this same batch loop re-claims the lead on its very
      // next iteration and burns all three attempts inside a second, which defeats the point of
      // retrying something transient like a brief WATI outage.
      await leads.updateOne(
        { _id: lead._id, onboardingState: 'claimed' },
        {
          $set: { onboardingState: 'due', onboardingDueAt: new Date(Date.now() + backoffMs), onboardingError: outcome.error },
          $unset: { onboardingClaimedAt: '' },
        },
      )
      result.failed++
      result.leads.push({ phone, leadId: String(lead.leadId), outcome: 'retry' })
    } else {
      // Either out of attempts, or ambiguous — a duplicate Confirm prompt is worse than a missed
      // one, so it is parked rather than retried.
      await leads.updateOne(
        { _id: lead._id, onboardingState: 'claimed' },
        { $set: { onboardingState: outcome.definitive ? 'failed' : 'unknown', onboardingError: outcome.error }, $unset: { onboardingClaimedAt: '' } },
      )
      result.failed++
      result.leads.push({ phone, leadId: String(lead.leadId), outcome: outcome.definitive ? 'failed' : 'unknown' })
    }

    if (gapMs > 0 && i < batch - 1) await new Promise((r) => setTimeout(r, gapMs))
  }

  return result
}

// Claims stranded by a crash between claim and finalise. Auto-reclaiming risks a duplicate (the
// trigger may have succeeded first), so by default they are parked for review.
export async function sweepStaleOnboardingClaims() {
  const db = await getDb()
  const cutoff = new Date(Date.now() - num('ONBOARDING_BOT_STALE_MINUTES', 15) * 60_000)
  const target = process.env.ONBOARDING_BOT_RECLAIM_STALE === 'true' ? 'due' : 'stuck'
  const res = await db.collection('vsl_leads').updateMany(
    { onboardingState: 'claimed', onboardingClaimedAt: { $lt: cutoff } },
    { $set: { onboardingState: target } },
  )
  return { movedTo: target, count: res.modifiedCount }
}
