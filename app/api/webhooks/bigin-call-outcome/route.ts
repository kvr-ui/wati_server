import { NextResponse } from 'next/server'
import { normalizePhone } from '@/lib/phone'
import { isNoResponseOutcome } from '@/nrdrip/config'
import { enrollFromCallOutcome } from '@/nrdrip/enroll'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const TAG = '[NR DRIP webhook]'

// How much of an unrecognised payload is written to the log. This endpoint is unauthenticated,
// so the cap is what stops a stranger using the log as free disk space.
const RAW_LOG_LIMIT = 2000

function str(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
    if (typeof c === 'number') return String(c)
  }
  return ''
}

// Bigin sends its lookup and multi-select fields as objects, not strings: Tag arrives as
// [{ name: 'NR', id: '119...' }] and Owner as { name, id, email }. Flatten either to the
// human-readable label(s), comma-joined, so a contact carrying several tags stays matchable.
function labels(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(labels).filter(Boolean).join(',')
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return str(o.name, o.Name, o.label, o.value)
  }
  return ''
}

// Everything this route answers is logged next to the payload that produced it, so a failed
// hook-up can be diagnosed from the log alone rather than from Zoho's side.
function reply(status: number, payload: Record<string, unknown>) {
  console.log(`${TAG} responding ${status}:`, JSON.stringify(payload))
  return NextResponse.json(payload, { status })
}

// Zoho Flow can be pointed at this as JSON or as a form post, and Bigin's own notifications
// wrap the record in { data: [ ... ] }. Accept all three rather than making the wiring guess.
function parseBody(raw: string, contentType: string): Record<string, unknown> | undefined {
  let parsed: unknown

  if (contentType.includes('form-urlencoded')) {
    parsed = Object.fromEntries(new URLSearchParams(raw))
  } else {
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A form post sent without the matching content-type still decodes cleanly here.
      const form = Object.fromEntries(new URLSearchParams(raw))
      parsed = Object.keys(form).length ? form : undefined
    }
  }

  if (!parsed || typeof parsed !== 'object') return undefined

  const body = parsed as Record<string, unknown>
  const envelope = body.data
  if (Array.isArray(envelope) && envelope[0] && typeof envelope[0] === 'object') {
    console.log(`${TAG} unwrapped data[0] envelope`)
    return { ...body, ...(envelope[0] as Record<string, unknown>) }
  }
  return body
}

// Zoho Flow fires this when the sales team logs a call against the Bigin contact.
//
// UNAUTHENTICATED, by request: anyone who learns this URL can enrol any phone number into the
// drip. What limits the damage is downstream, not here — NR_DRIP_ENABLED gates all sending,
// NR_DRIP_MAX_CANDIDATES refuses a run that suddenly has too many due leads, and the re-enrol
// cooldown stops the same number being enrolled repeatedly. Restrict this path at nginx (Zoho's
// published IP ranges) if the URL ever gets out.
export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || ''

  // Read as text first so the payload reaches the log even when it turns out to be unparseable.
  const raw = await request.text()
  console.log(`${TAG} content-type: ${contentType}`)
  console.log(`${TAG} raw body: ${raw.slice(0, RAW_LOG_LIMIT)}${raw.length > RAW_LOG_LIMIT ? ` …(${raw.length} bytes total)` : ''}`)

  const body = parseBody(raw, contentType)
  if (!body) return reply(400, { error: 'Body is neither JSON nor form-encoded', raw: raw.slice(0, 500) })

  console.log(`${TAG} parsed keys: ${JSON.stringify(Object.keys(body))}`)
  console.log(`${TAG} parsed body: ${JSON.stringify(body).slice(0, RAW_LOG_LIMIT)}`)

  // Bigin and Zoho Flow spell these differently depending on how the flow is wired, so accept
  // the shapes we have actually seen rather than demanding one.
  const phone = normalizePhone(str(body.phone, body.Phone, body.PHONE_NUMBER, body.mobile, body.Mobile, body.phoneNumber))

  // Bigin sends the name split in two; a single name field wins if the flow ever supplies one.
  const split = [str(body.First_Name, body.first_name), str(body.Last_Name, body.last_name)].filter(Boolean).join(' ')
  const name = (str(body.name, body.Name, body.NAME, body.Full_Name) || split).slice(0, 100)

  // Tag is last on purpose: it is where THIS Bigin flow records the call result, but a payload
  // carrying an explicit outcome field means what it says. Note CA_Status is NOT consulted —
  // it holds the student's course level ("Intermediate"), not anything about the call.
  const outcome =
    str(body.outcome, body.Outcome, body.Call_Result, body.callResult, body.Call_Status, body.Status, body.status) ||
    labels(body.Tag) ||
    labels(body.tag)
  const callId = str(body.callId, body.call_id, body.Call_Id, body.id, body.Id) || undefined

  console.log(`${TAG} extracted:`, JSON.stringify({ phone, name, outcome, callId }))

  // Both failures name the keys that were actually present, which is what tells you which field
  // the flow needs to be remapped to.
  if (!phone) return reply(400, { error: 'Invalid or missing phone', receivedKeys: Object.keys(body) })
  if (!outcome) return reply(400, { error: 'Missing call outcome', receivedKeys: Object.keys(body) })

  const isNoResponse = isNoResponseOutcome(outcome)
  console.log(`${TAG} outcome "${outcome}" -> ${isNoResponse ? 'NOT REACHED (enrol)' : 'reached / other (no drip)'}`)

  try {
    const result = await enrollFromCallOutcome({ phone, name, outcome, callId, isNoResponse })
    return reply(200, { success: true, ...result })
  } catch (error) {
    console.error(`${TAG} enrolment failed`, error)
    return reply(502, { error: 'Failed to process call outcome' })
  }
}

// Zoho Flow and Bigin both like to probe a webhook with a GET before saving it. Answering with
// something useful beats a 405 that reads as "the URL is wrong".
export async function GET() {
  console.log(`${TAG} GET probe received`)
  return NextResponse.json({ ok: true, expects: 'POST', route: '/api/webhooks/bigin-call-outcome' })
}
