import { NextResponse } from 'next/server'
import { sendWatiTemplateMessage } from '@/lib/wati'
import { getDb } from '@/lib/mongodb'

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const contactId = body.id ?? body.contactId ?? body.Contact_ID
  const rawName = body.name ?? body.NAME ?? body.Name
  const rawPhoneValue = body.phone ?? body.PHONE_NUMBER ?? body.Phone
  const email = body.email ?? body.EMAIL ?? body.Email

  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 100) : ''
  const rawPhone = typeof rawPhoneValue === 'string' ? rawPhoneValue : ''
  const phone = rawPhone.replace(/[^\d]/g, '').slice(0, 15)

  if (name.length < 2 || !/^\d{8,15}$/.test(phone)) {
    return NextResponse.json({ error: 'Invalid name or phone' }, { status: 400 })
  }

  try {
    // Store contact in database
    const db = await getDb()
    await db.collection('bigin_contacts').updateOne(
      { phone },
      {
        $set: {
          contactId: String(contactId),
          name,
          phone,
          email: typeof email === 'string' ? email : '',
          source: 'bigin_webhook',
          createdAt: new Date(),
        },
      },
      { upsert: true }
    )

    // Send initial onboarding bot template message
    await sendWatiTemplateMessage(phone, name)

    return NextResponse.json({ success: true, message: 'Contact stored and onboarding bot message sent' })
  } catch (error) {
    console.error('Bigin contact webhook failed', error)
    return NextResponse.json({ error: 'Failed to process contact' }, { status: 502 })
  }
}
