import { getDb } from './mongodb'

// Lead sources that must never receive a WhatsApp message from this app — no VSL link, no
// reminder, no onboarding bot, no drip. Compared case-insensitively.
const EXCLUDED_LEAD_SOURCES = new Set(['foundation school'])

// Bigin spells the field differently depending on which webhook sent it: the contact-created
// webhook sends LEAD_SOURCE, while a Zoho Flow that forwards the whole record sends the API name
// of the custom field, Lead_Source1. Picklists can also arrive as { name, id }.
export function readLeadSource(body: Record<string, unknown>): string {
  const value = body.LEAD_SOURCE ?? body.Lead_Source1 ?? body.Lead_Source ?? body.lead_source ?? body.leadSource
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const inner = o.name ?? o.Name ?? o.value
    return typeof inner === 'string' ? inner.trim() : ''
  }
  return ''
}

export function isExcludedLeadSource(leadSource: string | undefined) {
  return Boolean(leadSource) && EXCLUDED_LEAD_SOURCES.has(leadSource!.trim().toLowerCase())
}

// Remembers the lead source on the contact, which is what the scheduled jobs check later — they
// only ever see a phone number. An empty value is ignored so a payload that does not map the field
// cannot wipe one that another webhook recorded.
export async function recordLeadSource(phone: string, leadSource: string) {
  if (!leadSource) return
  const db = await getDb()
  await db.collection('bigin_contacts').updateOne({ phone }, { $set: { phone, leadSource } }, { upsert: true })
}

// The check every sender makes before messaging a lead.
export async function isExcludedLead(phone: string) {
  const db = await getDb()
  const contact = await db.collection('bigin_contacts').findOne({ phone }, { projection: { leadSource: 1 } })
  return isExcludedLeadSource(typeof contact?.leadSource === 'string' ? contact.leadSource : undefined)
}
