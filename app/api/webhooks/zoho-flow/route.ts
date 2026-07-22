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

  // Extract Bigin contact data (flexible field names)
  const rawName = body.name ?? body.NAME ?? body.Name ?? body.Full_Name ?? body.first_name
  const rawPhoneValue = body.phone ?? body.PHONE_NUMBER ?? body.Phone ?? body.phoneNumber ?? body.mobile
  const email = body.email ?? body.EMAIL ?? body.Email

  // Validate data
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 100) : ''
  const rawPhone = typeof rawPhoneValue === 'string' ? rawPhoneValue : ''
  const phone = rawPhone.replace(/[^\d]/g, '').slice(0, 15)

  console.log('Zoho Flow webhook received (Bigin contact):', { name, phone, email })

  if (name.length < 2 || !/^\d{8,15}$/.test(phone)) {
    console.error('Validation failed:', { nameLength: name.length, phoneValid: /^\d{8,15}$/.test(phone) })
    return NextResponse.json({ error: 'Invalid name or phone', details: { nameLength: name.length, phoneValid: /^\d{8,15}$/.test(phone) } }, { status: 400 })
  }

  try {
    // 1. Store contact in database
    const db = await getDb()
    await db.collection('bigin_contacts').updateOne(
      { phone },
      {
        $set: {
          name,
          phone,
          email: typeof email === 'string' ? email : '',
          source: 'bigin_webhook',
          createdAt: new Date(),
        },
      },
      { upsert: true }
    )

    // 2. Send WATI message to start onboarding bot
    await sendWatiTemplateMessage(phone, name)
    console.log('WATI onboarding message sent to:', phone)

    return NextResponse.json({ success: true, message: 'Contact stored and onboarding bot message sent' })
  } catch (error) {
    console.error('Zoho Flow webhook failed', error)
    return NextResponse.json({ error: 'Failed to process contact' }, { status: 502 })
  }
}
