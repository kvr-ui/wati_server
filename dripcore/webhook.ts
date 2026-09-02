import type { DripConfig } from './config'
import { cancelDrip, enrollFromTagOutcome } from './enroll'
import type { EnrollResult } from './types'

// What the route managed to pull out of the Bigin payload. Campaign-agnostic: the same extracted
// input is handed to every campaign, and each decides independently whether it applies.
export type TagWebhookInput = {
  phone: string
  name: string
  outcome: string
  callId?: string
  // Whether the payload carried a `Tag` key AT ALL, which is not the same as carrying an empty
  // one. See the tag-removal branch below.
  tagFieldPresent: boolean
}

// One campaign's decision about one webhook.
//
// Bigin fires on EVERY tag change and sends every tag the contact carries, so the same payload
// reaches every campaign and each one asks only "is my trigger tag still on this contact?".
// That is what makes the campaigns independent: a lead tagged `NR,Intermediate` is a trigger for
// both, and removing one tag ends only that one's chase.
export async function handleTagWebhook(cfg: DripConfig, input: TagWebhookInput): Promise<EnrollResult> {
  const { logTag, envPrefix, id: campaign } = cfg.campaign
  const { phone, name, outcome, callId, tagFieldPresent } = input

  // An empty trigger list makes every tag look like "not ours", which would enrol nobody and
  // cancel every running drip on the next tag change — quietly, with clean logs and 200s.
  // Refuse to touch anything until it is configured.
  if (!cfg.triggerTagsConfigured()) {
    console.error(`${logTag} ${envPrefix}TRIGGER_TAGS is empty — refusing to enrol or cancel anything`)
    return { action: 'ignored', phone, campaign, detail: `${envPrefix}TRIGGER_TAGS is not configured` }
  }

  // No tag on the contact. The drip only runs while the lead is STILL marked, and this flow
  // fires on tag removal too — so an empty tag on someone mid-drip means the mark came off and
  // the chase stops. For everyone else there is no active drip and this is a no-op.
  if (!outcome) {
    // "Tag key present but empty" is a real removal. "No Tag key at all" is some other
    // integration talking to this URL, and must not be allowed to silently stop a running drip.
    if (!tagFieldPresent) {
      console.warn(`${logTag} payload carries no Tag field at all — leaving any drip alone`)
      return { action: 'ignored', phone, campaign, detail: 'no Tag field in payload' }
    }
    const stopped = await cancelDrip(cfg, phone, 'tag_removed')
    console.log(`${logTag} contact has no tag — ${stopped ? 'active drip cancelled' : 'nothing to do'}`)
    return {
      action: stopped ? 'cancelled' : 'ignored',
      phone,
      campaign,
      detail: stopped ? 'trigger tag removed, drip stopped' : 'contact has no tag',
    }
  }

  const isTrigger = cfg.isTriggerTag(outcome)
  const stopped = cfg.isStopTag(outcome)
  console.log(
    `${logTag} outcome "${outcome}" -> ${isTrigger ? 'TRIGGER (enrol)' : stopped ? 'STOP tag (ends the chase)' : 'not this campaign (no drip)'}`,
  )

  return enrollFromTagOutcome(cfg, { phone, name, outcome, callId, isTrigger })
}
