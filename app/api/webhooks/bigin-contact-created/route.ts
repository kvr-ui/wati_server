import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { normalizePhone } from '@/lib/phone'
import { sendTrackedVslLink } from '@/lib/vslSend'

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

  // normalizePhone, not a bare digit strip: it applies DEFAULT_COUNTRY_CODE to a bare 10-digit
  // number, so this contact and the vsl_leads document keyed on the same person cannot end up as
  // two records — which would have the reminder and the onboarding bot chasing them twice.
  const phone = normalizePhone(rawPhoneValue)

  // WhatsApp push-names are frequently a single character or an emoji, and the name only
  // fills {{1}} in the template. Fall back to a neutral greeting rather than dropping an
  // otherwise valid lead — the phone number is the part that has to be right.
  const greetingName = name.length >= 2 ? name : 'there'

  if (!phone) {
    return NextResponse.json({ error: 'Invalid phone' }, { status: 400 })
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

    // The first message carries the VSL link. templateOnly because a contact who has just
    // appeared in Bigin has never messaged us, so their 24h window is closed and a free-form
    // send could only fail. Going through the tracked sender is what records linkSentAt, and so
    // what schedules both the 23h non-opener reminder and the +1h onboarding bot.
    const result = await sendTrackedVslLink(phone, greetingName, { templateOnly: true })
    console.log('VSL link send (contact created):', { phone, ...result })

    // 502 so Bigin retries: a definitive failure released the claim, so a retry genuinely resends.
    //
    // The second case is the quiet one. Once linkSendAttempts hits its cap the claim stops being
    // granted, so a persistently broken template stops producing errors and starts producing
    // "nothing happened" — no error field, no send. Reporting that as success would make a
    // misconfigured deploy look healthy while every lead silently receives nothing. `sending`
    // is excluded: that is a concurrent duplicate of this webhook, and the other caller is
    // mid-send.
    if (result.error) {
      return NextResponse.json({ error: 'Contact stored but VSL message failed', definitive: result.definitive }, { status: 502 })
    }
    if (!result.sent && !result.alreadySent && result.status !== 'sending') {
      console.error('VSL link not sent and not retryable', { phone, status: result.status })
      return NextResponse.json({ error: 'Contact stored but VSL message was not sent', status: result.status }, { status: 502 })
    }

    return NextResponse.json({ success: true, message: 'Contact stored and VSL link sent' })
  } catch (error) {
    console.error('Bigin contact webhook failed', error)
    return NextResponse.json({ error: 'Failed to process contact' }, { status: 502 })
  }
}
