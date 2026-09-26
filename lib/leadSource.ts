import { getDb } from './mongodb'

// Lead sources that must never receive a WhatsApp message from this app — no VSL link, no
// reminder, no onboarding bot, no drip. Compared case-insensitively.
const EXCLUDED_LEAD_SOURCES = new Set(['foundation school'])

// Lead sources that have already paid: no first VSL message, no Confirm template, no onboarding
// chatbot and no closing message — but the call-outcome drips and reminders still apply.
const NO_ONBOARDING_LEAD_SOURCES = new Set(['fs - paid'])

// Case- and spacing-insensitive, so "FS - PAID", "fs-paid" and "FS  -  Paid" all compare equal.
function normalize(leadSource: string) {
  return leadSource.trim().toLowerCase().replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ')
}

// Bigin spells the field differently depending on which webhook sent it: the contact-created
// webhook sends LEAD_SOURCE, while a Zoho Flow that forwards the whole record sends the API name
// of the custom field, Lead_Source1. Picklists can also arrive as { name, id }.
const LEAD_SOURCE_KEYS = ['LEAD_SOURCE', 'Lead_Source1', 'Lead_Source', 'lead_source', 'leadSource']

// Returns undefined when the payload does not carry the field at all — nothing is known, so a
// source recorded earlier stands. Returns '' when the field is there but empty (null, blank or
// Bigin's "-None-"): Bigin is saying the lead has no source now, which must clear an old one.
export function readLeadSource(body: Record<string, unknown>): string | undefined {
  const key = LEAD_SOURCE_KEYS.find((k) => k in body && body[k] !== undefined)
  if (!key) return undefined
  const value = body[key]
  let text = ''
  if (typeof value === 'string') text = value
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const inner = o.name ?? o.Name ?? o.value
    if (typeof inner === 'string') text = inner
  }
  text = text.trim()
  return text === '-None-' ? '' : text
}

export function isExcludedLeadSource(leadSource: string | undefined) {
  return Boolean(leadSource) && EXCLUDED_LEAD_SOURCES.has(normalize(leadSource!))
}

// The wider check for the new-lead funnel: the first VSL message and the onboarding flow.
export function isOnboardingExcludedLeadSource(leadSource: string | undefined) {
  return isExcludedLeadSource(leadSource) || (Boolean(leadSource) && NO_ONBOARDING_LEAD_SOURCES.has(normalize(leadSource!)))
}

// Remembers the lead source on the contact, which is what the scheduled jobs check later — they
// only ever see a phone number. A payload that does not carry the field leaves the stored value
// alone; one that carries it empty clears it, so a phone that was once a Foundation School lead
// and comes back as a normal lead is messaged again.
export async function recordLeadSource(phone: string, leadSource: string | undefined) {
  if (leadSource === undefined) return
  const db = await getDb()
  if (leadSource) {
    await db.collection('bigin_contacts').updateOne({ phone }, { $set: { phone, leadSource } }, { upsert: true })
  } else {
    await db.collection('bigin_contacts').updateOne({ phone }, { $unset: { leadSource: '' } })
  }
}

async function storedLeadSource(phone: string) {
  const db = await getDb()
  const contact = await db.collection('bigin_contacts').findOne({ phone }, { projection: { leadSource: 1 } })
  return typeof contact?.leadSource === 'string' ? contact.leadSource : undefined
}

// The check every sender makes before messaging a lead.
export async function isExcludedLead(phone: string) {
  return isExcludedLeadSource(await storedLeadSource(phone))
}

// The check the first VSL message and the onboarding flow make instead.
export async function isOnboardingExcludedLead(phone: string) {
  return isOnboardingExcludedLeadSource(await storedLeadSource(phone))
}
