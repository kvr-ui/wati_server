// FINAL DRIP, bound to the shared engine in dripcore/.
// Structurally identical to nrdrip/index.ts — only the descriptor differs.

import { makeDripConfig } from '@/dripcore/config'
import { cancelDrip as cancel } from '@/dripcore/enroll'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'
import { handleTagWebhook, type TagWebhookInput } from '@/dripcore/webhook'
import type { DripCancelReason } from '@/dripcore/types'
import { FINAL_CAMPAIGN } from './campaign'

export { FINAL_CAMPAIGN }

export const finalConfig = makeDripConfig(FINAL_CAMPAIGN)

export function handleFinalWebhook(input: TagWebhookInput) {
  return handleTagWebhook(finalConfig, input)
}

export function cancelFinalDrip(phone: string, reason: DripCancelReason) {
  return cancel(finalConfig, phone, reason)
}

export function runFinalDripBatch(options: { dryRun?: boolean } = {}) {
  return runDripBatch(finalConfig, options)
}

export function sweepStaleFinalDripClaims() {
  return sweepStaleClaims(finalConfig)
}
