import { buildVslUrl, renderMessage, sendSessionMessage, sendTemplate, sessionWindowRemainingMs } from '@/lib/wati'
import { envName } from './campaign'
import type { DripConfig } from './config'
import type { DripChannel } from './types'

export type StepSendResult =
  | { ok: true; channel: DripChannel }
  // Nothing is configured for this step yet. Not a failure of this lead — the runner moves them
  // on to the next step rather than parking them, so a step whose template has not been created
  // yet cannot permanently end someone's sequence.
  | { ok: false; notConfigured: true; windowClosed?: false; reason: string }
  // The 24h window has closed and this step has no approved template — nothing can be sent,
  // and retrying will not help, so the runner parks the lead instead of burning attempts.
  | { ok: false; notConfigured?: false; windowClosed: true; error: string }
  | { ok: false; notConfigured?: false; windowClosed?: false; definitive: boolean; error: string }

// undefined from WATI means it could not tell us (unconfigured, or the lookup failed).
// Attempting the session send is the cheap way to find out, and it fails harmlessly if the
// window turns out to be shut.
async function sessionWindowIsOpen(phone: string) {
  const remainingMs = await sessionWindowRemainingMs(phone)
  return remainingMs === undefined || remainingMs > 0
}

// Sends one step of a drip.
//
// Unlike the VSL messages, drip steps land on days 1, 3 and 6 — almost always OUTSIDE the 24h
// free-form window, which is why every step needs an approved template. The session message is
// the opportunistic path: cheaper, and it can carry a full URL and real line breaks, so it is
// tried first whenever the window is genuinely open.
export async function sendDripStep(
  cfg: DripConfig,
  phone: string,
  name: string,
  stepIndex: number,
): Promise<StepSendResult> {
  const url = cfg.dripUrl(buildVslUrl(phone, name))
  const template = cfg.stepTemplate(stepIndex)
  const copy = cfg.stepMessage(stepIndex)
  const text = copy ? renderMessage(copy, name, url) : undefined

  // Named from the campaign's own prefix, so the log tells you exactly which key to go and set.
  const messageKey = envName(cfg.campaign, `MESSAGE_${stepIndex + 1}`)
  const templateKey = envName(cfg.campaign, `TEMPLATE_${stepIndex + 1}`)

  if (!text && !template) {
    return {
      ok: false,
      notConfigured: true,
      reason: `step ${stepIndex + 1} has neither ${messageKey} nor ${templateKey}`,
    }
  }

  // Only worth asking WATI how much of the 24h window is left when there is session copy that
  // could use it. A template-only step would ignore the answer, and this is an API call per
  // lead per step.
  const windowOpen = text ? await sessionWindowIsOpen(phone) : false

  if (windowOpen && text) {
    const session = await sendSessionMessage(phone, text)
    if (session.ok) return { ok: true, channel: 'session' }
    if (!template) return { ok: false, definitive: session.definitive, error: session.error }
    console.warn(`${cfg.campaign.logTag} session message rejected, falling back to template`, template, session.error)
  }

  if (!template) {
    return { ok: false, windowClosed: true, error: `session window closed and ${templateKey} is not configured` }
  }

  // Only the variables this step's template actually declares — see stepTemplateParams.
  const available: Record<string, string> = { name: name || 'there', phone, url }
  const parameters = cfg.stepTemplateParams(stepIndex)
    .filter((key) => key in available)
    .map((key) => ({ name: key, value: available[key] }))

  const outcome = await sendTemplate(template, phone, parameters)
  if (outcome.ok) return { ok: true, channel: 'template' }
  return { ok: false, definitive: outcome.definitive, error: outcome.error }
}
