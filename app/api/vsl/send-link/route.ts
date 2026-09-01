import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { normalizePhone } from '@/lib/phone'
import { sendTrackedVslLink } from '@/lib/vslSend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Deliberately no CORS headers: lib/cors.ts falls back to '*' when WEBSITE_ORIGIN is unset,
// which would make an endpoint that WhatsApps caller-supplied numbers callable from any page.
function authorized(request: Request) {
  const expected = process.env.VSL_SEND_TOKEN
  if (!expected) return false
  const header = request.headers.get('authorization') || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const phone = normalizePhone(body.phone)
  if (!phone) return NextResponse.json({ error: 'Invalid phone' }, { status: 400 })
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''

  try {
    const result = await sendTrackedVslLink(phone, name)
    if (result.error) return NextResponse.json({ error: 'Send failed', definitive: result.definitive }, { status: 502 })
    return NextResponse.json(result)
  } catch (error) {
    console.error('VSL send-link failed', error)
    return NextResponse.json({ error: 'Send service unavailable' }, { status: 503 })
  }
}
