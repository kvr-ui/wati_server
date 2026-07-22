import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { resolveLead } from '@/lib/leads'

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Extract user data (flexible field names)
  const rawName = body.name ?? body.NAME ?? body.Name ?? body.userName ?? body.UserName
  const rawPhoneValue = body.phone ?? body.PHONE_NUMBER ?? body.Phone ?? body.phoneNumber ?? body.contact ?? body.Contact ?? body.mobile ?? body.Mobile

  // Extract onboarding bot answers (flexible field names)
  const botAnswers: Record<string, unknown> = {}
  Object.keys(body).forEach((key) => {
    if (!['name', 'NAME', 'Name', 'phone', 'PHONE_NUMBER', 'Phone'].includes(key)) {
      botAnswers[key] = body[key]
    }
  })

  // Validate data
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 100) : ''
  const rawPhone = typeof rawPhoneValue === 'string' ? rawPhoneValue : ''
  const phone = rawPhone.replace(/[^\d]/g, '').slice(0, 15)

  console.log('Onboarding webhook received:', { rawName, rawPhone, name, phone, allFields: body, bodyKeys: Object.keys(body) })

  if (name.length < 2) {
    console.error('Validation failed - invalid name:', { nameLength: name.length, name })
    return NextResponse.json({ error: 'Invalid name (minimum 2 characters)', details: { name, nameLength: name.length } }, { status: 400 })
  }

  if (!phone) {
    console.warn('Warning: phone is empty or missing. Will store data without phone sync to Bigin.')
    console.log('Received fields:', body)
  } else if (!/^\d{8,15}$/.test(phone)) {
    console.error('Validation failed - invalid phone:', { phone, phoneDigits: phone })
    return NextResponse.json({ error: 'Invalid phone format (must be 8-15 digits)', details: { phone, phoneDigits: phone } }, { status: 400 })
  }

  try {
    // 1. FIRST: Send to Zoho Flow immediately
    const zohoFlowUrl = 'https://flow.zoho.in/60069821829/flow/webhook/incoming?zapikey=1001.90d61085d37c5b93a4c4901339658ed6.4c726ffda3a8366d44b4694cd02f3d7f&isdebug=false'
    try {
      const zohoResponse = await fetch(zohoFlowUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, ...botAnswers }),
      })
      if (!zohoResponse.ok) {
        console.error('Zoho Flow webhook failed:', zohoResponse.status, await zohoResponse.text().catch(() => 'no response'))
      } else {
        console.log('Data sent to Zoho Flow successfully')
      }
    } catch (error) {
      console.error('Failed to send to Zoho Flow:', error)
    }

    const db = await getDb()
    const now = new Date()

    // 2. Resolve lead (create/update in vsl_leads)
    const leadId = await resolveLead(name, phone)

    // 3. Store/update onboarding bot answers in MongoDB (upsert to prevent duplicates)
    await db.collection('onboarding_responses').updateOne(
      { phone },
      {
        $set: {
          name,
          leadId,
          answers: botAnswers,
          receivedAt: now,
        },
      },
      { upsert: true }
    )

    // 4. Update bigin_contacts with onboarding completion
    await db.collection('bigin_contacts').updateOne(
      { phone },
      {
        $set: {
          onboardingCompleted: true,
          onboardingCompletedAt: now,
          leadId,
        },
      }
    )

    // 5. Send personalized thank-you message with VSL link via WATI session message (only if we have valid phone)
    const isTemplateVariable = name.includes('{{') || name.includes('@') || phone.includes('{{') || phone.includes('@')

    if (!isTemplateVariable && phone) {
      try {
        // Build personalized VSL tracking link with phone parameter
        const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3100'
        const vslLink = `${websiteUrl}/vsl?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`

        // Create personalized message
        const messageText = `Hi ${name},\n\nThank you for completing the onboarding! 🎉\n\nWe've prepared a personalized video just for you. Click the link below to watch:\n\n${vslLink}\n\nLooking forward to discussing this with you!`

        console.log('📤 Sending thank-you message via WATI session message to:', phone)

        // Get channel phone from env or use a default
        const channelPhone = process.env.WATI_CHANNEL_PHONE || '916383514285'

        // Use WATI session message endpoint
        const watiUrl = `${process.env.WATI_API_URL}/api/v1/sendSessionMessage/${phone}?messageText=${encodeURIComponent(messageText)}&channelPhoneNumber=${channelPhone}`

        const watiResponse = await fetch(watiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.WATI_TOKEN}`,
          },
        })

        const watiData = await watiResponse.json().catch(() => null)

        console.log('WATI Response:', { status: watiResponse.status, data: watiData })

        if (!watiResponse.ok) {
          console.error('❌ WATI send failed:', {
            status: watiResponse.status,
            response: watiData,
          })
          throw new Error(`WATI API error: ${watiResponse.status}`)
        }

        // Check if message was actually sent (result: true) or ticket expired (result: false)
        if (watiData?.result === false) {
          console.warn('⚠️ WATI message queued but ticket expired:', watiData?.message)
          console.warn('Note: Message will be sent when user responds or session is active')
        } else {
          console.log('✅ Thank you message with VSL link sent via WATI to:', phone)
        }
      } catch (error) {
        console.error('❌ Failed to send thank you message via WATI:', error)
      }
    } else {
      console.log('Skipped WATI message send - no valid phone')
    }

    return NextResponse.json({
      success: true,
      leadId,
      message: 'Onboarding completed, VSL tracking link sent via WATI',
    })
  } catch (error) {
    console.error('Onboarding bot webhook failed', error)
    return NextResponse.json({ error: 'Failed to process onboarding data' }, { status: 502 })
  }
}
