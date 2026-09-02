// NR DRIP, bound to the shared engine in dripcore/.
//
// Everything here is a one-line binding of a dripcore function to NR_CAMPAIGN. The state machine,
// the send path and the webhook decision tree are shared with every other tag campaign, so a bug
// fixed in dripcore/ is fixed for all of them at once.

import { makeDripConfig } from '@/dripcore/config'
import { cancelDrip as cancel } from '@/dripcore/enroll'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'
import { handleTagWebhook, type TagWebhookInput } from '@/dripcore/webhook'
import type { DripCancelReason } from '@/dripcore/types'
import { NR_CAMPAIGN } from './campaign'

export { NR_CAMPAIGN }

// Read lazily on every call rather than captured once: the readers all consult process.env at
// call time, so a test that changes an NR_DRIP_* value takes effect without a reload.
export const nrConfig = makeDripConfig(NR_CAMPAIGN)

export function handleNrWebhook(input: TagWebhookInput) {
  return handleTagWebhook(nrConfig, input)
}

export function cancelNrDrip(phone: string, reason: DripCancelReason) {
  return cancel(nrConfig, phone, reason)
}

export function runNrDripBatch(options: { dryRun?: boolean } = {}) {
  return runDripBatch(nrConfig, options)
}

export function sweepStaleNrDripClaims() {
  return sweepStaleClaims(nrConfig)
}
