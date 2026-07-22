import { NextResponse } from 'next/server'
import { resolveLead } from '@/lib/leads'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
    const phone = typeof body.phone === 'string' ? body.phone.replace(/[^\d+]/g, '').slice(0, 20) : ''
    if (name.length < 2 || !/^\+?[\d]{8,15}$/.test(phone)) return NextResponse.json({ error: 'Invalid lead details' }, { status: 400 })
    return NextResponse.json({ leadId: await resolveLead(name, phone) })
  } catch (error) {
    console.error('lead resolve failed', error)
    return NextResponse.json({ error: 'Lead service unavailable' }, { status: 503 })
  }
}
