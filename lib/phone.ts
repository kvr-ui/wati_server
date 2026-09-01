// One phone representation everywhere that touches vsl_leads.
//
// vsl_leads is keyed on `phone`, so two spellings of the same number become two documents
// for one human — and the reminder job would then chase someone who already watched the
// video. Historically /api/leads/resolve kept the leading "+" while the webhook paths
// stripped it, which is exactly that split waiting to happen.
//
// Returns the canonical digits-only form, or undefined when the input is not a usable number.
export function normalizePhone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined

  let digits = raw.replace(/\D/g, '')

  // International prefix written as 00 rather than +.
  if (digits.startsWith('00')) digits = digits.slice(2)

  // A bare local number (10 digits in India) gets the default country code so it matches
  // the same person stored from a webhook that already included it.
  const cc = (process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g, '')
  if (cc && digits.length === 10) digits = cc + digits

  if (digits.length < 8 || digits.length > 15) return undefined
  return digits
}
