// What distinguishes one tag drip from another.
//
// Everything else in dripcore/ is campaign-agnostic: the state machine, the send path and the
// webhook decision tree are identical whether the trigger tag is `NR` or `Intermediate`. A
// campaign is just the four facts that differ, plus whatever legacy env names it has to keep
// answering to.

export type DripCampaign = {
  // Written to every document's `campaign` field, so Followup_dashboard can tell the two apart
  // even if they are ever queried together.
  id: string
  // Its own Mongo collection. Sharing one is not an option: the unique index on `phone` is what
  // makes the enrolment upsert safe, and two campaigns in one collection would collide on it.
  collection: string
  // Every env key this campaign reads is `${envPrefix}${SUFFIX}` — e.g. NR_DRIP_ENABLED.
  envPrefix: string
  // Prefix for this campaign's log lines.
  logTag: string
  // Older names for a generic suffix, tried in order once the generic name turns out to be unset.
  // NR DRIP was configured by hand on a live server before this refactor, so its env keys have to
  // keep working untouched — an unread NR_DRIP_NR_OUTCOMES would enrol nobody and cancel every
  // running drip, silently (see nrdrip/KNOWN-ISSUES.md §4.2).
  aliases?: Record<string, string[]>
}

// The env var this campaign actually reads for a generic suffix.
//
// The generic name wins whenever it is set, so a campaign can always migrate off a legacy name by
// simply setting the new one. Aliases are the fallback, not an override.
export function envName(campaign: DripCampaign, suffix: string): string {
  const generic = `${campaign.envPrefix}${suffix}`
  if (process.env[generic] !== undefined) return generic
  for (const alias of campaign.aliases?.[suffix] ?? []) {
    if (process.env[alias] !== undefined) return alias
  }
  return generic
}

export function envValue(campaign: DripCampaign, suffix: string): string | undefined {
  return process.env[envName(campaign, suffix)]
}
