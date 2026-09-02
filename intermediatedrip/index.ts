// INTERMEDIATE DRIP, bound to the shared engine in dripcore/.
//
// Structurally identical to nrdrip/index.ts — the only difference between the two campaigns is
// the descriptor in campaign.ts and the env keys it names.

import { makeDripConfig } from '@/dripcore/config'
import { cancelDrip as cancel } from '@/dripcore/enroll'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'
import { handleTagWebhook, type TagWebhookInput } from '@/dripcore/webhook'
import type { DripCancelReason } from '@/dripcore/types'
import { INTERMEDIATE_CAMPAIGN } from './campaign'

export { INTERMEDIATE_CAMPAIGN }

export const intermediateConfig = makeDripConfig(INTERMEDIATE_CAMPAIGN)

export function handleIntermediateWebhook(input: TagWebhookInput) {
  return handleTagWebhook(intermediateConfig, input)
}

export function cancelIntermediateDrip(phone: string, reason: DripCancelReason) {
  return cancel(intermediateConfig, phone, reason)
}

export function runIntermediateDripBatch(options: { dryRun?: boolean } = {}) {
  return runDripBatch(intermediateConfig, options)
}

export function sweepStaleIntermediateDripClaims() {
  return sweepStaleClaims(intermediateConfig)
}
