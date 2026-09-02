// FOUNDATION DRIP, bound to the shared engine in dripcore/.
// Structurally identical to nrdrip/index.ts — only the descriptor differs.

import { makeDripConfig } from '@/dripcore/config'
import { cancelDrip as cancel } from '@/dripcore/enroll'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'
import { handleTagWebhook, type TagWebhookInput } from '@/dripcore/webhook'
import type { DripCancelReason } from '@/dripcore/types'
import { FOUNDATION_CAMPAIGN } from './campaign'

export { FOUNDATION_CAMPAIGN }

export const foundationConfig = makeDripConfig(FOUNDATION_CAMPAIGN)

export function handleFoundationWebhook(input: TagWebhookInput) {
  return handleTagWebhook(foundationConfig, input)
}

export function cancelFoundationDrip(phone: string, reason: DripCancelReason) {
  return cancel(foundationConfig, phone, reason)
}

export function runFoundationDripBatch(options: { dryRun?: boolean } = {}) {
  return runDripBatch(foundationConfig, options)
}

export function sweepStaleFoundationDripClaims() {
  return sweepStaleClaims(foundationConfig)
}
