// The shape of one NR DRIP enrolment. Mirrors the `nr_drip` collection.
//
// Deliberately a separate collection from vsl_leads: this is a second, independent lifecycle
// for the same human, and folding it into the lead document would put two state machines in
// one place where a careless update to one could strand the other.

export type NrDripState =
  | 'due'           // waiting for step `step` to come due
  | 'claimed'       // a runner holds the send mutex
  | 'completed'     // every step went out
  | 'cancelled'     // lead replied, or sales connected
  | 'failed'        // known-undelivered, out of attempts
  | 'unknown'       // ambiguous send outcome — parked rather than retried
  | 'window_closed' // outside the 24h window with no template configured for this step
  | 'stuck'         // claim stranded by a crash, parked for a human

export type NrDripChannel = 'session' | 'template'

export type NrDripStepLog = {
  index: number
  sentAt: Date
  channel: NrDripChannel
  error?: string
}

export type NrDripDoc = {
  phone: string
  leadId: string | null
  name: string
  watchPercentageAtEnroll: number | null

  enrolledAt: Date
  state: NrDripState
  step: number          // index of the NEXT step to send, 0-based
  dueAt: Date
  steps: NrDripStepLog[]

  attempts: number      // consecutive failures on the current step
  claimedAt?: Date
  lastError?: string
  cancelledAt?: Date
  cancelReason?: NrDripCancelReason
  completedAt?: Date

  sourceCallIds: string[]
  callAttempts: number
  lastCallAt?: Date
}

export type NrDripCancelReason = 'replied' | 'call_connected' | 'manual'

// What the Bigin webhook told us about one call.
export type CallOutcome = {
  phone: string
  name: string
  outcome: string
  callId?: string
  isNoResponse: boolean
}

export type EnrollResult = {
  action: 'enrolled' | 'reenrolled' | 'already_active' | 'cooldown' | 'cancelled' | 'ignored'
  phone: string
  state?: NrDripState
  step?: number
  dueAt?: Date
  detail?: string
}

export type NrDripBatchResult = {
  skipped?: string
  dryRun: boolean
  candidates: number
  claimed: number
  sent: number
  completed: number
  cancelled: number
  failed: number
  leads: { phone: string; step: number; outcome: string }[]
}
