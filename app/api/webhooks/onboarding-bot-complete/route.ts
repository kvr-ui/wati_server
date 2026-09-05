import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { resolveLead } from '@/lib/leads'
import { normalizePhone } from '@/lib/phone'
import { renderMessage, sendSessionMessage } from '@/lib/wati'

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
    const normalizedPhone = normalizePhone(phone)
    const leadId = normalizedPhone ? (await resolveLead(normalizedPhone, name)).leadId : ''

    // One spelling of the number across every collection. The contact webhooks now store the
    // normalized form, so writing the raw digits here would silently miss the bigin_contacts
    // document this lead already has — the update has no upsert, so it would simply do nothing.
    const contactPhone = normalizedPhone || phone

    // 3. Store/update onboarding bot answers in MongoDB (upsert to prevent duplicates)
    await db.collection('onboarding_responses').updateOne(
      { phone: contactPhone },
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
      { phone: contactPhone },
      {
        $set: {
          onboardingCompleted: true,
          onboardingCompletedAt: now,
          leadId,
        },
      }
    )

    // No VSL link is sent from here any more. The link now goes out on contact creation, an hour
    // BEFORE the bot is triggered, so by the time a lead reaches this webhook they have already
    // had it — sending it again would just be a duplicate.
    //
    // Nothing cancels a pending +1h bot trigger either: a lead who finds the bot on their own
    // still gets the scheduled message, which is the agreed behaviour.

    // 5. Close the conversation off, so the lead is not left on the bot's last question wondering
    // what happens next.
    //
    // A free-form session message rather than a template: the lead answered a question seconds
    // ago, so their 24h window is certainly open, and free-form needs no Meta approval and can
    // carry real line breaks. No default copy on purpose — if ONBOARDING_COMPLETE_MESSAGE is not
    // configured, nothing is sent rather than placeholder text reaching a real lead.
    //
    // Never allowed to fail the request: the answers are already stored and forwarded by this
    // point, and a 502 here would have Zoho retry the whole webhook and duplicate that work.
    const closingCopy = process.env.ONBOARDING_COMPLETE_MESSAGE
    if (closingCopy?.trim() && normalizedPhone) {
      try {
        const text = renderMessage(closingCopy, name, '')
        const outcome = await sendSessionMessage(normalizedPhone, text)
        if (!outcome.ok) console.error('Onboarding closing message failed', { phone: normalizedPhone, error: outcome.error })
      } catch (error) {
        console.error('Onboarding closing message threw', error)
      }
    }

    return NextResponse.json({
      success: true,
      leadId,
      message: 'Onboarding completed, responses stored',
    })
  } catch (error) {
    console.error('Onboarding bot webhook failed', error)
    return NextResponse.json({ error: 'Failed to process onboarding data' }, { status: 502 })
  }
}
