// WORKOUT DRIP, bound to the shared engine in dripcore/.
// Structurally identical to kitdrip/index.ts — only the descriptor differs.

import { makeDripConfig } from '@/dripcore/config'
import { cancelDrip as cancel } from '@/dripcore/enroll'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'
import { handleTagWebhook, type TagWebhookInput } from '@/dripcore/webhook'
import type { DripCancelReason } from '@/dripcore/types'
import { WORKOUT_CAMPAIGN } from './campaign'

export { WORKOUT_CAMPAIGN }

export const workoutConfig = makeDripConfig(WORKOUT_CAMPAIGN)

export function handleWorkoutWebhook(input: TagWebhookInput) {
  return handleTagWebhook(workoutConfig, input)
}

export function cancelWorkoutDrip(phone: string, reason: DripCancelReason) {
  return cancel(workoutConfig, phone, reason)
}

export function runWorkoutDripBatch(options: { dryRun?: boolean } = {}) {
  return runDripBatch(workoutConfig, options)
}

export function sweepStaleWorkoutDripClaims() {
  return sweepStaleClaims(workoutConfig)
}
