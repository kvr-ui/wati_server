import { getDb } from '@/lib/mongodb'
import { istHour } from '@/lib/vslReminders'
import { getLastInboundAt } from '@/lib/wati'
import { MAX_STEP_ATTEMPTS, type DripConfig } from './config'
import { sendDripStep } from './send'
import type { DripBatchResult, DripDoc } from './types'

function inQuietHours(cfg: DripConfig, now: Date) {
  const start = cfg.quietStartIst()
  const end = cfg.quietEndIst()
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
export async function runDripBatch(cfg: DripConfig, options: { dryRun?: boolean } = {}): Promise<DripBatchResult> {
  const dryRun = Boolean(options.dryRun)
  const { logTag, envPrefix } = cfg.campaign
  const result: DripBatchResult = {
    campaign: cfg.campaign.id,
    dryRun,
    candidates: 0,
    claimed: 0,
    sent: 0,
    skippedSteps: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    leads: [],
  }

  if (!dryRun && !cfg.enabled()) {
    return { ...result, skipped: `${envPrefix}ENABLED is not true` }
  }

  const now = new Date()
  if (!dryRun && inQuietHours(cfg, now)) {
    // No state change needed — dueAt is already in the past, so these simply go out on the
    // first run after quiet hours end.
    return { ...result, skipped: 'quiet hours (Asia/Kolkata)' }
  }

  const db = await getDb()
  // Typed so $push against `steps` is checked rather than degraded to a bare Document.
  const drips = db.collection<DripDoc>(cfg.campaign.collection)

  const due = { state: 'due' as const, dueAt: { $lte: now } }

  result.candidates = await drips.countDocuments(due)

  // Circuit breaker: a bad import or a backfill that wrongly stamped dueAt would show up here
  // as a huge candidate count. Refuse to message anyone until a human looks.
  const cap = cfg.maxCandidates()
  if (result.candidates > cap) {
    console.error(`${logTag} aborted: ${result.candidates} candidates exceeds ${envPrefix}MAX_CANDIDATES=${cap}`)
    return { ...result, skipped: `candidate count ${result.candidates} exceeds cap ${cap}` }
  }

  const batch = cfg.batchSize()

  if (dryRun) {
    const preview = await drips.find(due).sort({ dueAt: 1 }).limit(batch).toArray()
    result.leads = preview.map((d) => ({ phone: String(d.phone), step: Number(d.step ?? 0), outcome: 'would-send' }))
    return result
  }

  const gapMs = cfg.sendGapMs()

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

    const outcome = await sendDripStep(cfg, phone, name, step)

    // Where the lead goes once this step is behind them — the same transition whether the
    // message went out or the step simply had nothing configured to send.
    const nextStep = step + 1
    const nextDueAt = cfg.dueAtForStep(enrolledAt, nextStep)
    const advance = nextDueAt
      // attempts counts CONSECUTIVE failures on the current step, so leaving it clears them.
      ? { state: 'due' as const, step: nextStep, dueAt: nextDueAt, attempts: 0 }
      : { state: 'completed' as const, completedAt: new Date(), attempts: 0 }

    if (outcome.ok) {
      const sentAt = new Date()
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        {
          $set: advance,
          $push: { steps: { index: step, sentAt, channel: outcome.channel } },
          $unset: { claimedAt: '', lastError: '' },
        },
      )
      result.sent++
      if (!nextDueAt) result.completed++
      result.leads.push({ phone, step, outcome: nextDueAt ? `sent-${outcome.channel}` : `sent-${outcome.channel}-completed` })
    } else if (outcome.notConfigured) {
      // Nothing to send for this step yet, which is a gap in configuration rather than anything
      // about this lead. Skipping keeps them in the sequence — parking them here would be
      // terminal, and they would never resume once the template finally exists.
      console.warn(`${logTag} step skipped: ${outcome.reason}`)
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        { $set: advance, $unset: { claimedAt: '', lastError: '' } },
      )
      result.skippedSteps++
      if (!nextDueAt) result.completed++
      result.leads.push({ phone, step, outcome: 'skipped-not-configured' })
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
      // Known not delivered and attempts remain, so it goes back on the queue — but dueAt has
      // to move forward. Left in the past, this same batch loop re-claimed the lead on its very
      // next iteration and burned all three attempts inside a second, which defeats the whole
      // point of retrying something transient like a brief WATI outage.
      const retryAt = new Date(Date.now() + cfg.retryBackoffMs(Number(lead.attempts || 1)))
      await drips.updateOne(
        { _id: lead._id, state: 'claimed' },
        { $set: { state: 'due', dueAt: retryAt, lastError: outcome.error }, $unset: { claimedAt: '' } },
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
export async function sweepStaleClaims(cfg: DripConfig) {
  const db = await getDb()
  const cutoff = new Date(Date.now() - cfg.staleClaimMs())
  const target = cfg.reclaimStale() ? 'due' : 'stuck'
  const res = await db.collection(cfg.campaign.collection).updateMany(
    { state: 'claimed', claimedAt: { $lt: cutoff } },
    { $set: { state: target } },
  )
  return { movedTo: target, count: res.modifiedCount }
}
