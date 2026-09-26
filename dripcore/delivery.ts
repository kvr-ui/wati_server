import { getDb } from '@/lib/mongodb'
import { getTemplateHistory, type TemplateHistoryEntry } from '@/lib/wati'
import type { DripConfig } from './config'
import type { DripDeliveryStatus, DripDoc, DripStepLog } from './types'

// Checks what actually became of each drip template send, and queues a re-send when it did not
// reach the lead.
//
// The runner marks a step sent the moment WATI answers `result: true`, but that is only WATI
// accepting it. Two things happen after that which the runner never sees:
//   - Meta refuses it ("restricted it for higher quality messaging"): its per-person limit on
//     marketing templates. WATI records these as FAILED, and Meta's advice is to retry in days.
//   - WATI never records the send at all. Rare, but it happened to 7 sends on 2026-09-26 while
//     every other send that day was recorded within seconds.
//
// A re-send puts the drip back to `due` on the same step, so it goes out through runDripBatch
// like any other send: quiet hours, the reply check, the lead-source exclusion and the claim all
// still apply.

// A history entry this far either side of our sentAt is the same send. WATI stamps it within a
// second or two; the width only has to cover clock skew and a slow API.
const MATCH_BEFORE_MS = 2 * 60_000
const MATCH_AFTER_MS = 15 * 60_000

// Meta's marketing limit clears on its own, so these are worth another try later. Anything else
// Meta refuses (an invalid number, the user in a Meta experiment) will fail the same way again.
const META_LIMIT = /restricted it for higher quality|131049/i

export type DeliveryCheckResult = {
  campaign: string
  skipped?: string
  checked: number
  delivered: number
  failed: number
  missing: number
  pending: number
  retriesQueued: number
  leads: { phone: string; step: number; delivery: DripDeliveryStatus; detail?: string; retry?: string }[]
}

type Verdict = { delivery: DripDeliveryStatus; detail?: string; matchedCreated?: number } | { pending: true }

function judge(entry: DripStepLog, template: string, history: TemplateHistoryEntry[], used: Set<number>, missingAfterMs: number, now: number): Verdict {
  const sentAt = new Date(entry.sentAt).getTime()
  let best: TemplateHistoryEntry | undefined
  for (const h of history) {
    const t = h.created.getTime()
    if (used.has(t)) continue
    if (h.template !== template) continue
    if (t < sentAt - MATCH_BEFORE_MS || t > sentAt + MATCH_AFTER_MS) continue
    if (!best || Math.abs(t - sentAt) < Math.abs(best.created.getTime() - sentAt)) best = h
  }

  if (best) {
    if (best.status.toUpperCase() === 'FAILED') return { delivery: 'failed', detail: best.failedDetail.slice(0, 200), matchedCreated: best.created.getTime() }
    // SENT is still in flight at Meta and can yet turn into FAILED, so it is only final once old.
    if (best.status.toUpperCase() === 'SENT' && now - sentAt < missingAfterMs) return { pending: true }
    return { delivery: 'delivered', matchedCreated: best.created.getTime() }
  }
  if (now - sentAt < missingAfterMs) return { pending: true }
  return { delivery: 'missing', detail: 'accepted by WATI but never recorded in its message history' }
}

export async function checkDripDeliveries(cfg: DripConfig): Promise<DeliveryCheckResult> {
  const { logTag, envPrefix } = cfg.campaign
  const result: DeliveryCheckResult = { campaign: cfg.campaign.id, checked: 0, delivered: 0, failed: 0, missing: 0, pending: 0, retriesQueued: 0, leads: [] }

  if (!cfg.deliveryCheckEnabled()) return { ...result, skipped: `${envPrefix}DELIVERY_CHECK is false` }

  const now = Date.now()
  const db = await getDb()
  const drips = db.collection<DripDoc>(cfg.campaign.collection)

  const unchecked = await drips
    .find({
      steps: {
        $elemMatch: { channel: 'template', delivery: { $exists: false }, sentAt: { $gte: new Date(now - cfg.deliveryLookbackMs()) } },
      },
    })
    .limit(cfg.maxCandidates())
    .toArray()

  for (const lead of unchecked) {
    const phone = String(lead.phone)
    const history = await getTemplateHistory(phone)
    // WATI could not be asked. Unknown is not "missing" — try again on the next run.
    if (!history) continue

    // A history record matched to one send is not matched to another in the same run.
    const used = new Set<number>()
    const steps = lead.steps || []
    for (let i = 0; i < steps.length; i++) {
      const entry = steps[i]
      if (entry.channel !== 'template' || entry.delivery) continue
      if (new Date(entry.sentAt).getTime() < now - cfg.deliveryLookbackMs()) continue

      result.checked++
      const template = entry.template || cfg.stepTemplate(entry.index)
      // Without the template name any other template sent around the same time would pass for
      // this one, so an unknown send is left unjudged rather than guessed at.
      if (!template) continue
      const verdict = judge(entry, template, history, used, cfg.deliveryMissingAfterMs(), now)
      if ('pending' in verdict) {
        result.pending++
        continue
      }
      if (verdict.matchedCreated) used.add(verdict.matchedCreated)
      result[verdict.delivery]++

      const record = {
        [`steps.${i}.delivery`]: verdict.delivery,
        [`steps.${i}.deliveryCheckedAt`]: new Date(),
        ...(verdict.detail ? { [`steps.${i}.deliveryDetail`]: verdict.detail } : {}),
      }

      const retryable = verdict.delivery === 'missing' || (verdict.delivery === 'failed' && META_LIMIT.test(verdict.detail || ''))
      const retriesLeft = Number(lead.deliveryRetries || 0) < cfg.deliveryMaxRetries()
      // Only the lead's newest send is re-sent. An older entry that failed has already been
      // followed by another send, which is the one that matters now.
      const isLatest = i === steps.length - 1
      // A cancelled drip (the lead replied, or the tag changed) is never revived by a re-send.
      const resumable = lead.state === 'completed' || lead.state === 'due'

      let retry: string | undefined
      if (retryable && retriesLeft && isLatest && resumable) {
        const delay = verdict.delivery === 'missing' ? cfg.deliveryMissingRetryMs() : cfg.deliveryMetaRetryMs()
        const dueAt = new Date(now + delay)
        // Filtered on the state it was read in, so a webhook that re-enrolled or cancelled the lead
        // meanwhile wins and nothing is queued behind its back.
        const res = await drips.updateOne(
          { _id: lead._id, state: lead.state, [`steps.${i}.retryQueued`]: { $ne: true }, [`steps.${i}.delivery`]: { $exists: false } },
          {
            $set: { ...record, [`steps.${i}.retryQueued`]: true, state: 'due', step: entry.index, dueAt, attempts: 0 },
            $inc: { deliveryRetries: 1 },
            $unset: { completedAt: '' },
          },
        )
        if (res.modifiedCount) {
          retry = dueAt.toISOString()
          result.retriesQueued++
          console.warn(`${logTag} ${verdict.delivery} send to ${phone} (step ${entry.index + 1}), re-send queued for ${retry}`, verdict.detail || '')
          result.leads.push({ phone, step: entry.index, delivery: verdict.delivery, detail: verdict.detail, retry })
          continue
        }
      }

      await drips.updateOne({ _id: lead._id, [`steps.${i}.delivery`]: { $exists: false } }, { $set: record })
      if (verdict.delivery !== 'delivered') {
        console.warn(`${logTag} ${verdict.delivery} send to ${phone} (step ${entry.index + 1}), not retried`, verdict.detail || '')
        result.leads.push({ phone, step: entry.index, delivery: verdict.delivery, detail: verdict.detail })
      }
    }
  }

  return result
}
