// The shape of one drip enrolment. Mirrors each campaign's collection (`nr_drip`,
// `intermediate_drip`, …) — they share this schema exactly.
//
// Deliberately separate from vsl_leads: this is a second, independent lifecycle for the same
// human, and folding it into the lead document would put two state machines in one place where a
// careless update to one could strand the other.

export type DripState =
  | 'due'           // waiting for step `step` to come due
  | 'claimed'       // a runner holds the send mutex
  | 'completed'     // every step went out
  | 'cancelled'     // lead replied, or the tag changed
  | 'failed'        // known-undelivered, out of attempts
  | 'unknown'       // ambiguous send outcome — parked rather than retried
  | 'window_closed' // outside the 24h window with no template configured for this step
  | 'stuck'         // claim stranded by a crash, parked for a human

export type DripChannel = 'session' | 'template'

export type DripStepLog = {
  index: number
  sentAt: Date
  channel: DripChannel
  error?: string
}

export type DripDoc = {
  phone: string
  // Which campaign this record belongs to — 'nr', 'intermediate', … Each lives in its own
  // collection, so this is for reporting rather than for filtering the runner's queries.
  campaign: string
  leadId: string | null
  name: string
  watchPercentageAtEnroll: number | null

  enrolledAt: Date
  state: DripState
  step: number          // index of the NEXT step to send, 0-based
  dueAt: Date
  steps: DripStepLog[]

  attempts: number      // consecutive failures on the current step
  claimedAt?: Date
  lastError?: string
  cancelledAt?: Date
  cancelReason?: DripCancelReason
  completedAt?: Date

  sourceCallIds: string[]
  callAttempts: number
  lastCallAt?: Date
}

export type DripCancelReason = 'replied' | 'tag_changed' | 'tag_removed' | 'manual'

// What the Bigin webhook told us about one contact, as far as ONE campaign is concerned.
// `isTrigger` is campaign-specific: the same payload is a trigger for NR and not for Intermediate.
export type TagOutcome = {
  phone: string
  name: string
  outcome: string
  callId?: string
  isTrigger: boolean
}

export type EnrollResult = {
  action: 'enrolled' | 'reenrolled' | 'already_active' | 'cooldown' | 'cancelled' | 'ignored'
  phone: string
  campaign?: string
  state?: DripState
  step?: number
  dueAt?: Date
  detail?: string
}

export type DripBatchResult = {
  campaign: string
  skipped?: string
  dryRun: boolean
  candidates: number
  claimed: number
  sent: number
  skippedSteps: number
  completed: number
  cancelled: number
  failed: number
  leads: { phone: string; step: number; outcome: string }[]
}
