// Every environment variable NR DRIP reads, in one place.
//
// The copy deliberately has no default. An unconfigured deploy should be loudly broken rather
// than quietly sending placeholder text to a real lead — the same policy as `messageBody` in
// lib/wati.ts.

export const COLLECTION = 'nr_drip'

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

export function cancelOnConnected() {
  // Defaults ON: continuing to send "we tried to reach you" after sales actually spoke to the
  // lead would be plainly wrong. Set to 'false' for reply-only cancellation.
  return process.env.NR_DRIP_CANCEL_ON_CONNECTED !== 'false'
}

// Case-insensitive match against the call outcome Bigin reports.
//
// The outcome arrives from a Bigin Tag, which is multi-value: a contact can carry several tags
// and Zoho renders them joined ("Not Reachable,Hot Lead"). So this matches if ANY value in the
// field is a not-reached marker, rather than comparing the whole string.
export function isNoResponseOutcome(outcome: string) {
  const wanted = list('NR_DRIP_NR_OUTCOMES').map((s) => s.toLowerCase())
  if (!wanted.length) return false
  const present = outcome.split(/[,;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  return present.some((value) => wanted.includes(value))
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
