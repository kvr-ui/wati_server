// Every environment variable NR DRIP reads, in one place.
//
// The copy deliberately has no default. An unconfigured deploy should be loudly broken rather
// than quietly sending placeholder text to a real lead — the same policy as `messageBody` in
// lib/wati.ts.

export const COLLECTION = 'nr_drip'

// Which campaign records written by this module belong to. The other Bigin tags will get their
// own sequences alongside it.
export const CAMPAIGN = 'nr'

export const MAX_STEP_ATTEMPTS = 3

function num(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

function list(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function enabled() {
  return process.env.NR_DRIP_ENABLED === 'true'
}

export function cancelOnTagChange() {
  // Defaults ON: continuing to send "we tried to reach you" after the lead has moved to another
  // tag's campaign would be plainly wrong. Set to 'false' for reply-only cancellation.
  // NR_DRIP_CANCEL_ON_CONNECTED is the original name, still honoured.
  const raw = process.env.NR_DRIP_CANCEL_ON_TAG_CHANGE ?? process.env.NR_DRIP_CANCEL_ON_CONNECTED
  return raw !== 'false'
}

// Whether the trigger list has been configured at all.
//
// An empty list makes every tag look like "not NR", which would enrol nobody AND cancel every
// running drip on the next tag change — silently, with clean logs. Callers check this and
// refuse to act, rather than quietly dismantling the campaign.
export function nrOutcomesConfigured() {
  return list('NR_DRIP_NR_OUTCOMES').length > 0
}

function tagsIn(outcome: string) {
  return outcome.split(/[,;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
}

// Tags that end the chase outright, even when NR is on the contact too.
//
// Bigin sends EVERY tag the contact carries, so a lead can arrive as "NR,CWOS" — still marked
// not-reached, but also closed. Without this the NR match wins and a closed lead keeps being
// chased. Descriptive tags ("Hot Lead") are not outcomes and must not appear here.
export function isStopOutcome(outcome: string) {
  const stops = list('NR_DRIP_STOP_OUTCOMES').map((s) => s.toLowerCase())
  if (!stops.length) return false
  return tagsIn(outcome).some((value) => stops.includes(value))
}

// Case-insensitive match against the call outcome Bigin reports. True when any tag on the
// contact is a not-reached marker — but a stop tag anywhere overrides it.
export function isNoResponseOutcome(outcome: string) {
  if (isStopOutcome(outcome)) return false
  const wanted = list('NR_DRIP_NR_OUTCOMES').map((s) => s.toLowerCase())
  if (!wanted.length) return false
  return tagsIn(outcome).some((value) => wanted.includes(value))
}

// Hours from enrolment at which each step fires — Day 0 / 1 / 3 by default.
// The minutes variant wins when set, so the cadence can be compressed for testing without
// disturbing the production values.
export function stepOffsetsMs(): number[] {
  const minutes = list('NR_DRIP_STEP_OFFSETS_MINUTES').map(Number).filter((n) => Number.isFinite(n) && n >= 0)
  if (minutes.length) return minutes.map((m) => m * 60_000)

  const hours = list('NR_DRIP_STEP_OFFSETS').map(Number).filter((n) => Number.isFinite(n) && n >= 0)
  if (hours.length) return hours.map((h) => h * 3600_000)

  return [0, 24, 72].map((h) => h * 3600_000)
}

export function stepCount() {
  return stepOffsetsMs().length
}

// When step `index` (0-based) is due, measured from enrolment.
export function dueAtForStep(enrolledAt: Date, index: number): Date | undefined {
  const offsets = stepOffsetsMs()
  if (index < 0 || index >= offsets.length) return undefined
  return new Date(enrolledAt.getTime() + offsets[index])
}

// Steps are numbered from 1 in the env var names, because that is how a human counts messages.
export function stepMessage(index: number): string | undefined {
  const raw = process.env[`NR_DRIP_MESSAGE_${index + 1}`]
  return raw && raw.trim() ? raw : undefined
}

export function stepTemplate(index: number): string | undefined {
  const raw = process.env[`NR_DRIP_TEMPLATE_${index + 1}`]
  return raw && raw.trim() ? raw.trim() : undefined
}

// Which variables to send with a step's template. Defaults to just `name`, because that is what
// the approved templates actually declare — passing variables a template does not use risks the
// send being rejected outright. Widen per step (e.g. "name,url") only to match a template that
// really takes more.
export function stepTemplateParams(index: number): string[] {
  const configured = list(`NR_DRIP_TEMPLATE_PARAMS_${index + 1}`)
  if (!configured.length) return ['name']
  // Some approved templates take no variables at all (re_nurture), and sending one anyway can
  // get the message rejected. "none" is how a step says that explicitly, since an empty env
  // value is indistinguishable from an unset one.
  if (configured.length === 1 && configured[0].toLowerCase() === 'none') return []
  return configured
}

export function reenrollCooldownMs() {
  return num('NR_DRIP_REENROLL_AFTER_HOURS', 168) * 3600_000
}

export function quietStartIst() {
  return num('NR_DRIP_QUIET_START_IST', 21)
}

export function quietEndIst() {
  return num('NR_DRIP_QUIET_END_IST', 9)
}

export function batchSize() {
  return num('NR_DRIP_BATCH', 25)
}

export function sendGapMs() {
  return num('NR_DRIP_SEND_GAP_MS', 400)
}

// How long a failed step waits before its next attempt. Grows with the attempt number so a
// longer WATI outage is not burned through at a fixed interval.
export function retryBackoffMs(attempt: number) {
  return Math.max(1, attempt) * num('NR_DRIP_RETRY_BACKOFF_MINUTES', 15) * 60_000
}

export function maxCandidates() {
  return num('NR_DRIP_MAX_CANDIDATES', 200)
}

export function staleClaimMs() {
  return num('NR_DRIP_STALE_MINUTES', 15) * 60_000
}

export function reclaimStale() {
  return process.env.NR_DRIP_RECLAIM_STALE === 'true'
}

// The link the drip copy points at. Defaults to the lead's own VSL link (a rewatch), but is
// usually better pointed at a booking or callback page — set NR_DRIP_URL to override.
export function dripUrl(fallback: string) {
  const raw = process.env.NR_DRIP_URL
  return raw && raw.trim() ? raw.trim() : fallback
}
