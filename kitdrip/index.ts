// KIT DRIP, bound to the shared engine in dripcore/.
// Structurally identical to foundationdrip/index.ts — only the descriptor differs.

import { makeDripConfig } from '@/dripcore/config'
import { cancelDrip as cancel } from '@/dripcore/enroll'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'
import { handleTagWebhook, type TagWebhookInput } from '@/dripcore/webhook'
import type { DripCancelReason } from '@/dripcore/types'
import { KIT_CAMPAIGN } from './campaign'

export { KIT_CAMPAIGN }

export const kitConfig = makeDripConfig(KIT_CAMPAIGN)

export function handleKitWebhook(input: TagWebhookInput) {
  return handleTagWebhook(kitConfig, input)
}

export function cancelKitDrip(phone: string, reason: DripCancelReason) {
  return cancel(kitConfig, phone, reason)
}

export function runKitDripBatch(options: { dryRun?: boolean } = {}) {
  return runDripBatch(kitConfig, options)
}

export function sweepStaleKitDripClaims() {
  return sweepStaleClaims(kitConfig)
}
