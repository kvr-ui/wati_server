// Every environment variable a drip campaign reads, in one place.
//
// `makeDripConfig(campaign)` binds these to one campaign's env prefix, so NR DRIP reads
// NR_DRIP_ENABLED and the Intermediate drip reads INTERMEDIATE_DRIP_ENABLED from identical code.
//
// The copy deliberately has no default. An unconfigured deploy should be loudly broken rather
// than quietly sending placeholder text to a real lead — the same policy as `messageBody` in
// lib/wati.ts.

import { envValue, type DripCampaign } from './campaign'

export const MAX_STEP_ATTEMPTS = 3

export function makeDripConfig(campaign: DripCampaign) {
  function raw(suffix: string) {
    return envValue(campaign, suffix)
  }

  function num(suffix: string, fallback: number) {
    const value = Number(raw(suffix))
    return Number.isFinite(value) ? value : fallback
  }

  function list(suffix: string): string[] {
    return (raw(suffix) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  // Bigin sends every tag the contact carries as one comma-joined string.
  function tagsIn(outcome: string) {
    return outcome.split(/[,;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  }

  // A named object rather than a bare literal so the methods can call each other through `api`
  // instead of `this`. A caller that destructures — `const { isTriggerTag } = cfg` — would break
  // `this`, and the failure mode is silent: every tag would stop matching.
  const api = {
    campaign,

    enabled() {
      return raw('ENABLED') === 'true'
    },

    cancelOnTagChange() {
      // Defaults ON: continuing to chase after the lead has moved to another tag's campaign would
      // be plainly wrong. Set to 'false' for reply-only cancellation.
      return raw('CANCEL_ON_TAG_CHANGE') !== 'false'
    },

    // Whether the trigger list has been configured at all.
    //
    // An empty list makes every tag look like "not ours", which would enrol nobody AND cancel
    // every running drip on the next tag change — silently, with clean logs. Callers check this
    // and refuse to act, rather than quietly dismantling the campaign.
    triggerTagsConfigured() {
      return list('TRIGGER_TAGS').length > 0
    },

    // Tags that end the chase outright, even when the trigger tag is on the contact too.
    //
    // Bigin sends EVERY tag, so a lead can arrive as "NR,CWOS" — still marked not-reached, but
    // also closed. Without this the trigger match wins and a closed lead keeps being chased.
    // Descriptive tags ("Hot Lead") are not outcomes and must not appear here.
    isStopTag(outcome: string) {
      const stops = list('STOP_TAGS').map((s) => s.toLowerCase())
      if (!stops.length) return false
      return tagsIn(outcome).some((value) => stops.includes(value))
    },

    // Case-insensitive match against the tags Bigin reports. True when any tag on the contact is
    // this campaign's trigger — but a stop tag anywhere overrides it.
    isTriggerTag(outcome: string) {
      if (api.isStopTag(outcome)) return false
      const wanted = list('TRIGGER_TAGS').map((s) => s.toLowerCase())
      if (!wanted.length) return false
      return tagsIn(outcome).some((value) => wanted.includes(value))
    },

    // Hours from enrolment at which each step fires — Day 0 / 1 / 3 by default.
    // The minutes variant wins when set, so the cadence can be compressed for testing without
    // disturbing the production values.
    stepOffsetsMs(): number[] {
      const minutes = list('STEP_OFFSETS_MINUTES').map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      if (minutes.length) return minutes.map((m) => m * 60_000)

      const hours = list('STEP_OFFSETS').map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      if (hours.length) return hours.map((h) => h * 3600_000)

      return [0, 24, 72].map((h) => h * 3600_000)
    },

    stepCount() {
      return api.stepOffsetsMs().length
    },

    // When step `index` (0-based) is due, measured from enrolment.
    dueAtForStep(enrolledAt: Date, index: number): Date | undefined {
      const offsets = api.stepOffsetsMs()
      if (index < 0 || index >= offsets.length) return undefined
      return new Date(enrolledAt.getTime() + offsets[index])
    },

    // Steps are numbered from 1 in the env var names, because that is how a human counts messages.
    stepMessage(index: number): string | undefined {
      const value = raw(`MESSAGE_${index + 1}`)
      return value && value.trim() ? value : undefined
    },

    stepTemplate(index: number): string | undefined {
      const value = raw(`TEMPLATE_${index + 1}`)
      return value && value.trim() ? value.trim() : undefined
    },

    // Which variables to send with a step's template. Defaults to just `name`, because that is
    // what the approved templates actually declare — passing variables a template does not use
    // risks the send being rejected outright. Widen per step (e.g. "name,url") only to match a
    // template that really takes more.
    stepTemplateParams(index: number): string[] {
      const configured = list(`TEMPLATE_PARAMS_${index + 1}`)
      if (!configured.length) return ['name']
      // Some approved templates take no variables at all (re_nurture), and sending one anyway can
      // get the message rejected. "none" is how a step says that explicitly, since an empty env
      // value is indistinguishable from an unset one.
      if (configured.length === 1 && configured[0].toLowerCase() === 'none') return []
      return configured
    },

    reenrollCooldownMs() {
      return num('REENROLL_AFTER_HOURS', 168) * 3600_000
    },

    quietStartIst() {
      return num('QUIET_START_IST', 21)
    },

    quietEndIst() {
      return num('QUIET_END_IST', 9)
    },

    batchSize() {
      return num('BATCH', 25)
    },

    sendGapMs() {
      return num('SEND_GAP_MS', 400)
    },

    // How long a failed step waits before its next attempt. Grows with the attempt number so a
    // longer WATI outage is not burned through at a fixed interval.
    retryBackoffMs(attempt: number) {
      return Math.max(1, attempt) * num('RETRY_BACKOFF_MINUTES', 15) * 60_000
    },

    maxCandidates() {
      return num('MAX_CANDIDATES', 200)
    },

    staleClaimMs() {
      return num('STALE_MINUTES', 15) * 60_000
    },

    reclaimStale() {
      return raw('RECLAIM_STALE') === 'true'
    },

    // The link the drip copy points at. Defaults to the lead's own VSL link (a rewatch), but is
    // usually better pointed at a booking or callback page — set the campaign's URL to override.
    dripUrl(fallback: string) {
      const value = raw('URL')
      return value && value.trim() ? value.trim() : fallback
    },
  }

  return api
}

export type DripConfig = ReturnType<typeof makeDripConfig>
