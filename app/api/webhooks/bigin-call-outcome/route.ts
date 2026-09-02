import { NextResponse, after } from 'next/server'
import { normalizePhone } from '@/lib/phone'
import type { EnrollResult } from '@/dripcore/types'
import type { TagWebhookInput } from '@/dripcore/webhook'
import { handleTagWebhook } from '@/dripcore/webhook'
import { runDripBatch } from '@/dripcore/runner'
import { requeueNow } from '@/dripcore/enroll'
import { ALL_DRIPS } from '@/lib/drips'
import type { DripConfig } from '@/dripcore/config'

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

// The two enrolment outcomes that put a lead at step 0 with `dueAt` of now, and so have a message
// ready to go immediately. Every other action — already_active, cooldown, cancelled, ignored —
// either has nothing due or deliberately must not send.
const STARTED = new Set(['enrolled', 'reenrolled'])

// How hard the instant send tries before giving up, and how long it waits between goes.
//
// Only NR has a cron to come back for a lead later. For the brochure campaigns this request IS the
// only delivery attempt there will ever be, so a two-second WATI blip would otherwise lose the
// lead silently. Three tries about five and fifteen seconds apart cover a transient failure
// without holding the process open for long. It costs nothing when the first try succeeds, which
// is the normal case.
const INSTANT_RETRY_DELAYS_MS = [5_000, 15_000]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// One campaign's immediate send for one lead. Never throws: this runs after the response is on the
// wire, so an error here cannot be reported to Zoho and must not take down the request.
async function sendNow(cfg: DripConfig, phone: string) {
  const tag = cfg.campaign.logTag

  for (let attempt = 0; ; attempt++) {
    let outcome: string
    try {
      const result = await runDripBatch(cfg, { phone })
      outcome = result.skipped ?? result.leads[0]?.outcome ?? 'nothing due'
    } catch (error) {
      outcome = `threw: ${String((error as Error)?.message || error).slice(0, 200)}`
    }

    // `retry` is the runner's word for "definitely not delivered, attempts left". Anything else is
    // either done (sent, completed, skipped, cancelled) or a state retrying cannot help — out of
    // attempts, an ambiguous send we must not repeat, or the campaign being switched off.
    const worthRetrying = outcome === 'retry' || outcome.startsWith('threw:')
    const delay = INSTANT_RETRY_DELAYS_MS[attempt]

    if (!worthRetrying || delay === undefined) {
      const level = worthRetrying ? console.error : console.log
      level(`${tag} instant send for ${phone}: ${outcome}${worthRetrying ? ' — GIVING UP, lead left due' : ''}`)
      return
    }

    console.warn(`${tag} instant send for ${phone}: ${outcome} — retrying in ${delay / 1000}s`)
    await sleep(delay)
    // A failed attempt pushed dueAt out by the retry backoff, which assumes a cron. Pull it back
    // so this next attempt can actually claim the lead.
    await requeueNow(cfg, phone).catch(() => {})
  }
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

  // Zoho pings the URL with an empty body to validate it before letting you save the webhook.
  // Answering anything but 2xx there makes it retry and refuse the configuration.
  if (!raw.trim()) return reply(200, { success: true, action: 'ignored', detail: 'empty body (validation ping)' })

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
  // carrying an explicit outcome field means what it says. Bigin sends EVERY tag the contact
  // carries, comma-joined, which is what lets one payload trigger several campaigns at once.
  //
  // CA_Status is still NOT consulted. It holds the student's course level, which happens to also
  // read "Intermediate" — but the Intermediate campaign keys off the Tag, like every other one.
  const outcome =
    str(body.outcome, body.Outcome, body.Call_Result, body.callResult, body.Call_Status, body.Status, body.status) ||
    labels(body.Tag) ||
    labels(body.tag)
  const callId = str(body.callId, body.call_id, body.Call_Id, body.id, body.Id) || undefined

  // An empty tag means "the tag was taken off" only if the flow actually sent a Tag field. A
  // payload with no Tag key at all is some other integration talking to this URL, and must not
  // be allowed to silently stop a running drip.
  const tagFieldPresent = 'Tag' in body || 'tag' in body

  console.log(`${TAG} extracted:`, JSON.stringify({ phone, name, outcome, callId, tagFieldPresent }))

  // Acknowledged, not rejected. This webhook fires on EVERY tag change on a contact — including
  // a tag being REMOVED, which legitimately arrives with an empty Tag array. That is nothing to
  // act on rather than a failure, and Zoho would otherwise mark the whole run failed and retry.
  //
  // The tradeoff: a genuinely misconfigured flow (wrong field mapped, so no phone ever arrives)
  // now looks successful from Zoho's side. `detail` and `receivedKeys` in the response body are
  // where that shows up, so read the body rather than trusting the status code alone.
  if (!phone) {
    console.warn(`${TAG} no usable phone — nothing to do`)
    return reply(200, { success: true, action: 'ignored', detail: 'no usable phone in payload', receivedKeys: Object.keys(body) })
  }

  const input: TagWebhookInput = { phone, name, outcome, callId, tagFieldPresent }

  // Every campaign in lib/drips.ts sees the same payload and decides for itself. They are
  // independent: a lead tagged `NR,Intermediate` enrols in both and gets both sequences, and
  // dropping one tag ends only that campaign's chase. Each writes to its own collection, so none
  // can corrupt another's state.
  //
  // Sequential rather than parallel on purpose — four concurrent Mongo round trips per webhook,
  // on a hook Zoho fires for every tag change, is not worth the few milliseconds.
  const campaigns: Record<string, EnrollResult> = {}
  try {
    for (const cfg of ALL_DRIPS) {
      campaigns[cfg.campaign.id] = await handleTagWebhook(cfg, input)
    }
  } catch (error) {
    // A campaign that threw has left the DB in whatever state it reached, so 502 asks Zoho to
    // retry the whole payload. That is safe: a repeat while a drip is active is `already_active`
    // and a repeat after it ended is `cooldown`, so no lead is enrolled or messaged twice.
    console.error(`${TAG} enrolment failed`, error)
    return reply(502, { error: 'Failed to process call outcome', campaigns })
  }

  // Send the first message NOW rather than leaving the lead to wait for a cron tick.
  //
  // Deliberately AFTER the response: `after()` runs this once Zoho already has its 200, so a slow
  // WATI can never make Zoho time out and re-fire the webhook — which would be a duplicate message
  // to the lead. If the process dies mid-send the lead simply stays `due` and the cron picks them
  // up, which is the same outcome as never having tried.
  //
  // This is the ordinary runner scoped to one phone, not a second send path, so it still honours
  // the master switch, quiet hours, the reply check and the atomic claim. A lead tagged at 11pm is
  // held for the morning exactly as before, and a cron tick landing at the same moment loses the
  // claim instead of double-sending.
  const kick = ALL_DRIPS.filter((cfg) => STARTED.has(campaigns[cfg.campaign.id]?.action))
  if (kick.length) {
    after(async () => {
      for (const cfg of kick) await sendNow(cfg, phone)
    })
  }

  // NR's result stays at the TOP LEVEL, unchanged. Monitoring built against `"action":"enrolled"`
  // predates every later campaign (see nrdrip/KNOWN-ISSUES.md §2.2) and must keep reading the same
  // field. Per-campaign detail lives under `campaigns`.
  return reply(200, { success: true, ...campaigns.nr, campaigns, sendingNow: kick.map((c) => c.campaign.id) })
}

// Zoho Flow and Bigin both like to probe a webhook with a GET before saving it. Answering with
// something useful beats a 405 that reads as "the URL is wrong".
export async function GET() {
  console.log(`${TAG} GET probe received`)
  return NextResponse.json({ ok: true, expects: 'POST', route: '/api/webhooks/bigin-call-outcome' })
}
