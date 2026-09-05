// Prints the chatbots in the WATI account, so you can map a name you know ("Contact Onboarding
// v3") to the id WATI_CHATBOT_ID needs. Read-only.
//
// Run it where the WATI credentials live — the server, not a laptop:
//
//   WATI_API_URL=... WATI_TOKEN=... node scripts/list-chatbots.mjs
const baseUrl = process.env.WATI_API_URL
const token = process.env.WATI_TOKEN
if (!baseUrl || !token) throw new Error('WATI_API_URL and WATI_TOKEN must be set')

// v3 first (Pro plan), then the v1 path, since which one an account exposes varies.
for (const path of ['/api/ext/v3/chatbots', '/api/v1/chatbots']) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    console.log(`${path} -> ${res.status}`)
    continue
  }
  const items = body?.result || body?.data || body?.chatbots || body
  console.log(`\n${path}:`)
  console.log(JSON.stringify(items, null, 2))
  break
}
