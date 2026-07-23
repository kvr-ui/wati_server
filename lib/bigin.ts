let cachedToken: { value: string; expiresAt: number } | undefined

function domainSuffix() {
  return process.env.ZOHO_REGION || 'com'
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value

  const clientId = process.env.ZOHO_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIENT_SECRET
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Bigin is not configured (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)')
  }

  const params = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
  const res = await fetch(`https://accounts.zoho.${domainSuffix()}/oauth/v2/token?${params}`, { method: 'POST' })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.access_token) throw new Error(`Bigin token refresh failed: ${res.status} ${JSON.stringify(data)}`)

  cachedToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 }
  return cachedToken.value
}

async function biginFetch(path: string, init?: RequestInit) {
  const token = await getAccessToken()
  return fetch(`https://www.zohoapis.${domainSuffix()}${path}`, { ...init, headers: { ...init?.headers, Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } })
}

export async function findContactIdByPhone(phone: string) {
  const res = await biginFetch(`/bigin/v2/Contacts/search?phone=${encodeURIComponent(phone)}`)
  if (res.status === 204) return undefined
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Bigin contact search failed: ${res.status} ${JSON.stringify(data)}`)
  return data?.data?.[0]?.id as string | undefined
}

export async function addNoteToContact(contactId: string, content: string) {
  const res = await biginFetch(`/bigin/v2/Contacts/${contactId}/Notes`, { method: 'POST', body: JSON.stringify({ data: [{ Note_Content: content }] }) })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Bigin add note failed: ${res.status} ${JSON.stringify(data)}`)
  return data
}

// Writes VSL watch time to the Bigin contact as ONE note per session, keyed by phone number.
// First call creates the note (returns its id); later calls update the same note so the
// watched time keeps growing in place instead of spamming a new note on every progress tick.
export async function syncVslWatchTime(phone: string, watchedSeconds: number, watchPercentage: number, noteId?: string) {
  const contactId = await findContactIdByPhone(phone)
  if (!contactId) return noteId
  const minutes = (watchedSeconds / 60).toFixed(1)
  const pct = Math.round(watchPercentage)
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  const content = `VSL watch time: ${minutes} min (${pct}%) as of ${when}`
  return upsertNote(contactId, noteId, content)
}

// Note updates go to the top-level Notes resource (PUT /Notes/{id}); the parented
// path /Contacts/{contactId}/Notes/{noteId} is only valid for creating notes, not updating.
export async function updateNote(noteId: string, content: string) {
  const res = await biginFetch(`/bigin/v2/Notes/${noteId}`, { method: 'PUT', body: JSON.stringify({ data: [{ Note_Content: content }] }) })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Bigin update note failed: ${res.status} ${JSON.stringify(data)}`)
  return data
}

// Updates the existing note if noteId is set, otherwise creates one. If the update fails
// (stale/deleted note id, e.g. from another environment) it self-heals by creating a fresh
// note and returning its id so the caller can cache the new value.
async function upsertNote(contactId: string, noteId: string | undefined, content: string) {
  if (noteId) {
    try { await updateNote(noteId, content); return noteId }
    catch (error) { console.error('Bigin note update failed, creating a new note', error) }
  }
  const data = await addNoteToContact(contactId, content)
  return (data?.data?.[0]?.details?.id as string | undefined) || undefined
}

// Writes the visitor's time-on-site to the Bigin contact as ONE note per session.
// First call creates the note (returns its id); later calls update the same note so the
// minutes keep growing in place instead of spamming a new note on every exit.
export async function syncSiteSession(phone: string, noteId: string | undefined, content: string) {
  const contactId = await findContactIdByPhone(phone)
  if (!contactId) return noteId
  return upsertNote(contactId, noteId, content)
}
