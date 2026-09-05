// Outcome of a template send, classified so callers know whether a retry is safe.
//   definitive: true  — we know the message did NOT go out (4xx, or 200 with result:false).
//   definitive: false — ambiguous (network error, timeout, 5xx); it may have gone out, so
//                       nothing may auto-retry it.
export type SendOutcome = { ok: true; data: unknown } | { ok: false; definitive: boolean; error: string }

export type TemplateParam = { name: string; value: string }

function dryRun() {
  return process.env.WATI_DRY_RUN === 'true'
}

export async function sendTemplate(templateName: string | undefined, phone: string, parameters: TemplateParam[]): Promise<SendOutcome> {
  const baseUrl = process.env.WATI_API_URL
  const token = process.env.WATI_TOKEN
  if (!baseUrl || !token) return { ok: false, definitive: true, error: 'WATI is not configured (WATI_API_URL / WATI_TOKEN)' }
  if (!templateName) return { ok: false, definitive: true, error: 'Template name is not configured' }

  // Local development and dry runs must never message a real person.
  if (dryRun()) {
    console.log('[WATI dry-run] template', templateName, '->', phone, JSON.stringify(parameters))
    return { ok: true, data: { dryRun: true } }
  }

  const url = `${baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ template_name: templateName, broadcast_name: `${templateName}_${Date.now()}`, parameters }),
    })
  } catch (error) {
    return { ok: false, definitive: false, error: String((error as Error)?.message || error).slice(0, 300) }
  }

  const data = await res.json().catch(() => null)
  // A 5xx may still have delivered; treat it as ambiguous rather than retryable.
  if (res.status >= 500) return { ok: false, definitive: false, error: `WATI ${res.status} ${JSON.stringify(data)}`.slice(0, 300) }
  // WATI answers 200 with result:false for an unapproved template or a non-WhatsApp number,
  // so the status code alone is not enough.
  if (!res.ok || data?.result === false) return { ok: false, definitive: true, error: `WATI ${res.status} ${JSON.stringify(data)}`.slice(0, 300) }
  return { ok: true, data }
}

// Which variables a template actually declares. Sending one it does NOT declare gets the whole
// message rejected by WATI, so this is per-template configuration rather than a constant — the
// same contract as a drip step's TEMPLATE_PARAMS (see dripcore/config.ts).
//
//   unset  -> the defaults passed in
//   'none' -> no variables at all
//   'name,url' -> exactly those, in that order
function templateParams(envVar: string, defaults: string[]) {
  const raw = process.env[envVar]
  if (raw === undefined || !raw.trim()) return defaults
  if (raw.trim().toLowerCase() === 'none') return []
  return raw.split(',').map((k) => k.trim()).filter(Boolean)
}

// Resolves the configured variable names against what we know about this lead, dropping any key
// we cannot fill rather than sending it empty.
function paramsFor(envVar: string, defaults: string[], available: Record<string, string>): TemplateParam[] {
  return templateParams(envVar, defaults)
    .filter((key) => key in available)
    .map((key) => ({ name: key, value: available[key] }))
}

// The first message a new Bigin contact receives: an approved template that CARRIES the VSL link.
// A contact created in the CRM has no open 24h window, so free-form is not an option here — the
// template is the only thing that can reach them.
//
// Whether the link rides in a URL button (with `phone` as the dynamic suffix) or in the body (as
// `url`) is decided by WATI_VSL_TEMPLATE_PARAMS, not by this code.
export async function sendVslLinkTemplate(phone: string, name: string): Promise<SendOutcome> {
  const available = { name: name || 'there', phone, url: buildVslUrl(phone, name) }
  const parameters = paramsFor('WATI_VSL_TEMPLATE_PARAMS', ['name', 'phone'], available)
  return sendTemplate(process.env.WATI_VSL_TEMPLATE_NAME, phone, parameters)
}

// The "Confirm" template. Tapping/sending Confirm is what fires the onboarding chatbot's keyword
// trigger inside WATI — this template is the only way to reach a lead whose 24h window has closed.
export async function sendOnboardingTemplate(phone: string, name: string): Promise<SendOutcome> {
  const parameters = paramsFor('WATI_ONBOARDING_TEMPLATE_PARAMS', ['name'], { name: name || 'there', phone })
  return sendTemplate(process.env.WATI_ONBOARDING_TEMPLATE_NAME, phone, parameters)
}

// Starts the onboarding chatbot flow directly, no keyword needed.
//
// The flow's first message is free-form, so this only REACHES the lead inside the 24h window —
// and WATI answers result:true for "flow started", not for "message delivered". A call against a
// closed window therefore looks like a success while the lead receives nothing (and still burns a
// billable chatbot session), which is why callers must check the window themselves first rather
// than trusting this outcome.
export async function startChatbot(phone: string): Promise<SendOutcome> {
  const baseUrl = process.env.WATI_API_URL
  const token = process.env.WATI_TOKEN
  const chatbotId = process.env.WATI_CHATBOT_ID
  if (!baseUrl || !token) return { ok: false, definitive: true, error: 'WATI is not configured (WATI_API_URL / WATI_TOKEN)' }
  if (!chatbotId) return { ok: false, definitive: true, error: 'WATI_CHATBOT_ID is not configured' }

  if (dryRun()) {
    console.log('[WATI dry-run] start chatbot', chatbotId, '->', phone)
    return { ok: true, data: { dryRun: true } }
  }

  const url = `${baseUrl}/api/v1/chatbots/start`
    + `?chatbotId=${encodeURIComponent(chatbotId)}`
    + `&whatsappNumber=${encodeURIComponent(phone)}`

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  } catch (error) {
    return { ok: false, definitive: false, error: String((error as Error)?.message || error).slice(0, 300) }
  }

  const data = await res.json().catch(() => null)
  if (res.status >= 500) return { ok: false, definitive: false, error: `WATI ${res.status} ${JSON.stringify(data)}`.slice(0, 300) }
  if (!res.ok || data?.result === false) return { ok: false, definitive: true, error: `WATI ${res.status} ${JSON.stringify(data)}`.slice(0, 300) }
  return { ok: true, data }
}

// ---------------------------------------------------------------------------------------
// Session messages
//
// WhatsApp allows a free-form message within 24h of the lead's last INBOUND message. Inside
// that window we can send the VSL link as ordinary text — no Meta-approved template, no
// approval wait, no per-message template cost — and the text can carry the full URL with both
// phone and name, which a template's URL button (one parameter) cannot.
// ---------------------------------------------------------------------------------------

export function buildVslUrl(phone: string, name?: string) {
  const base = process.env.WEBSITE_URL || 'http://localhost:3100'
  const params = new URLSearchParams({ phone })
  if (name) params.set('name', name)
  return `${base}/vsl?${params.toString()}`
}

export function renderMessage(template: string, name: string, url: string) {
  // Env files cannot hold real newlines, so copy is written with literal \n and unescaped here.
  return template
    .replace(/\\n/g, '\n')
    .replace(/\{\{\s*name\s*\}\}/g, name || 'there')
    .replace(/\{\{\s*url\s*\}\}/g, url)
}

export async function sendSessionMessage(phone: string, text: string): Promise<SendOutcome> {
  const baseUrl = process.env.WATI_API_URL
  const token = process.env.WATI_TOKEN
  if (!baseUrl || !token) return { ok: false, definitive: true, error: 'WATI is not configured' }

  if (dryRun()) {
    console.log('[WATI dry-run] session message ->', phone, '|', text.replace(/\n/g, ' ').slice(0, 120))
    return { ok: true, data: { dryRun: true } }
  }

  const channel = process.env.WATI_CHANNEL_PHONE
  const url = `${baseUrl}/api/v1/sendSessionMessage/${encodeURIComponent(phone)}`
    + `?messageText=${encodeURIComponent(text)}`
    + (channel ? `&channelPhoneNumber=${encodeURIComponent(channel)}` : '')

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  } catch (error) {
    return { ok: false, definitive: false, error: String((error as Error)?.message || error).slice(0, 300) }
  }
  const data = await res.json().catch(() => null)
  if (res.status >= 500) return { ok: false, definitive: false, error: `WATI ${res.status}`.slice(0, 300) }
  // A closed session window comes back as 200 with result:false ("ticket expired").
  if (!res.ok || data?.result === false) return { ok: false, definitive: true, error: `WATI ${res.status} ${JSON.stringify(data)}`.slice(0, 300) }
  return { ok: true, data }
}

// Timestamp of the lead's most recent inbound message, which is what the 24h window runs from.
// `owner: false` marks a message from the lead; `owner: true` is us, and entries with no owner
// are system events.
export async function getLastInboundAt(phone: string): Promise<Date | undefined> {
  const baseUrl = process.env.WATI_API_URL
  const token = process.env.WATI_TOKEN
  if (!baseUrl || !token) return undefined

  // Keep local runs hermetic: assume a fresh window rather than calling the live account.
  if (dryRun()) return new Date()

  try {
    const res = await fetch(`${baseUrl}/api/v1/getMessages/${encodeURIComponent(phone)}?pageSize=30`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return undefined
    const json = await res.json().catch(() => null)
    const items = json?.messages?.items || json?.result?.messages?.items || json?.items || []
    let latest: number | undefined
    for (const m of items) {
      if (m?.owner !== false) continue
      const at = Date.parse(m.created || m.timestamp || '')
      if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at
    }
    return latest === undefined ? undefined : new Date(latest)
  } catch {
    return undefined
  }
}

// How long is left on the lead's 24h window. Negative means it has closed.
export async function sessionWindowRemainingMs(phone: string): Promise<number | undefined> {
  const lastInbound = await getLastInboundAt(phone)
  if (!lastInbound) return undefined
  return lastInbound.getTime() + 24 * 3600_000 - Date.now()
}

// Sends free-form inside the window, and only falls back to an approved template when the
// window has closed and one is configured.
async function sendLinkMessage(phone: string, name: string, text: string, fallbackTemplate: string | undefined, paramsEnvVar: string): Promise<SendOutcome> {
  const session = await sendSessionMessage(phone, text)
  if (session.ok) return session
  if (fallbackTemplate) {
    console.warn('session message rejected, falling back to template', fallbackTemplate, session.error)
    // Only the variables this template declares — an undeclared one gets the send rejected.
    const available = { name: name || 'there', phone, url: buildVslUrl(phone, name) }
    return sendTemplate(fallbackTemplate, phone, paramsFor(paramsEnvVar, ['name', 'phone'], available))
  }
  return session
}

// No default copy on purpose. If the wording is not configured, refuse to send rather than
// deliver placeholder text to a real lead — an unconfigured deploy should be loudly broken,
// not quietly embarrassing.
function messageBody(envVar: string, name: string, url: string): string | undefined {
  const template = process.env[envVar]
  if (!template || !template.trim()) return undefined
  return renderMessage(template, name, url)
}

export async function sendVslLink(phone: string, name: string): Promise<SendOutcome> {
  const url = buildVslUrl(phone, name)
  const text = messageBody('VSL_LINK_MESSAGE', name, url)
  if (!text) return { ok: false, definitive: true, error: 'VSL_LINK_MESSAGE is not configured' }
  return sendLinkMessage(phone, name, text, process.env.WATI_VSL_TEMPLATE_NAME, 'WATI_VSL_TEMPLATE_PARAMS')
}

export async function sendVslReminder(phone: string, name: string): Promise<SendOutcome> {
  const url = buildVslUrl(phone, name)
  const text = messageBody('VSL_REMINDER_MESSAGE', name, url)
  if (!text) return { ok: false, definitive: true, error: 'VSL_REMINDER_MESSAGE is not configured' }
  return sendLinkMessage(phone, name, text, process.env.WATI_REMINDER_TEMPLATE_NAME, 'WATI_REMINDER_TEMPLATE_PARAMS')
}
