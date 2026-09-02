import { buildVslUrl, renderMessage, sendSessionMessage, sendTemplate, sessionWindowRemainingMs } from '@/lib/wati'
import { dripUrl, stepMessage, stepTemplate, stepTemplateParams } from './config'
import type { NrDripChannel } from './types'

export type NrStepSendResult =
  | { ok: true; channel: NrDripChannel }
  // The 24h window has closed and this step has no approved template — nothing can be sent,
  // and retrying will not help, so the runner parks the lead instead of burning attempts.
  | { ok: false; windowClosed: true; error: string }
  | { ok: false; windowClosed?: false; definitive: boolean; error: string }

// Sends one step of the drip.
//
// Unlike the VSL messages, NR steps land on days 1, 3 and 6 — almost always OUTSIDE the 24h
// free-form window, which is why every step needs an approved template. The session message is
// the opportunistic path: cheaper, and it can carry a full URL and real line breaks, so it is
// tried first whenever the window is genuinely open.
export async function sendNrDripStep(phone: string, name: string, stepIndex: number): Promise<NrStepSendResult> {
  const url = dripUrl(buildVslUrl(phone, name))
  const template = stepTemplate(stepIndex)
  const copy = stepMessage(stepIndex)
  const text = copy ? renderMessage(copy, name, url) : undefined

  if (!text && !template) {
    return {
      ok: false,
      definitive: true,
      error: `step ${stepIndex + 1} has neither NR_DRIP_MESSAGE_${stepIndex + 1} nor NR_DRIP_TEMPLATE_${stepIndex + 1}`,
    }
  }

  // undefined means WATI could not tell us (unconfigured, or the lookup failed). Attempting the
  // session send is the cheap way to find out, and it fails harmlessly if the window is shut.
  const remainingMs = await sessionWindowRemainingMs(phone)
  const windowOpen = remainingMs === undefined || remainingMs > 0

  if (windowOpen && text) {
    const session = await sendSessionMessage(phone, text)
    if (session.ok) return { ok: true, channel: 'session' }
    if (!template) return { ok: false, definitive: session.definitive, error: session.error }
    console.warn('NR drip session message rejected, falling back to template', template, session.error)
  }

  if (!template) {
    return { ok: false, windowClosed: true, error: `session window closed and NR_DRIP_TEMPLATE_${stepIndex + 1} is not configured` }
  }

  // Only the variables this step's template actually declares — see stepTemplateParams.
  const available: Record<string, string> = { name: name || 'there', phone, url }
  const parameters = stepTemplateParams(stepIndex)
    .filter((key) => key in available)
    .map((key) => ({ name: key, value: available[key] }))

  const outcome = await sendTemplate(template, phone, parameters)
  if (outcome.ok) return { ok: true, channel: 'template' }
  return { ok: false, definitive: outcome.definitive, error: outcome.error }
}
