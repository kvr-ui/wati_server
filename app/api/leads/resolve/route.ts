import { NextResponse } from 'next/server'
import { resolveLead } from '@/lib/leads'
import { normalizePhone } from '@/lib/phone'
import { corsHeaders } from '@/lib/cors'

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

// The VSL link sent from a WhatsApp template button can only carry the phone number, so the
// name is optional here. Returning the stored name lets the page still greet the lead by
// name instead of falling back to "future CA".
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
    const phone = normalizePhone(body.phone)
    if (!phone) return NextResponse.json({ error: 'Invalid phone' }, { status: 400, headers: corsHeaders() })
    return NextResponse.json(await resolveLead(phone, name), { headers: corsHeaders() })
  } catch (error) {
    console.error('lead resolve failed', error)
    return NextResponse.json({ error: 'Lead service unavailable' }, { status: 503, headers: corsHeaders() })
  }
}
