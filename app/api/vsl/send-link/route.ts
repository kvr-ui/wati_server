import { NextResponse } from 'next/server'
import { randomUUID, timingSafeEqual } from 'crypto'
import { getDb } from '@/lib/mongodb'
import { normalizePhone } from '@/lib/phone'
import { sendVslLink } from '@/lib/wati'

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

// 23h, not 24: the reminder must land INSIDE the lead's 24h WhatsApp session window, where a
// free-form message is allowed. At 24h the window has closed and only a paid, Meta-approved
// template would go through.
function reminderDelayMs() {
  // Minutes win when set, so the delay can be dialled down to seconds-scale for testing
  // without touching the 23h production default.
  const minutes = Number(process.env.VSL_REMINDER_DELAY_MINUTES)
  if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60_000
  const hours = Number(process.env.VSL_REMINDER_DELAY_HOURS)
  return (Number.isFinite(hours) && hours >= 0 ? hours : 23) * 3600_000
}

const MAX_SEND_ATTEMPTS = 3

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
    const db = await getDb()
    const leads = db.collection('vsl_leads')
    const now = new Date()

    // The lead may already exist because they reached the page some other way, so only
    // insert-time fields go in here.
    await leads.updateOne(
      { phone },
      {
        $setOnInsert: {
          leadId: randomUUID(),
          phone,
          name,
          createdAt: now,
          videoId: process.env.BUNNY_STREAM_VIDEO_ID || '',
          source: 'vsl_link_send',
          // Seeded explicitly: the claim below filters on $lt, and $lt never matches a
          // missing field, so without this the very first send could not claim.
          linkSendAttempts: 0,
        },
      },
      { upsert: true },
    )

    // Claim before sending. One atomic document operation is the entire idempotency
    // guarantee: whichever caller wins the claim sends, everyone else is told it is already
    // done. This is what absorbs a Zoho Flow webhook retry.
    const claimed = await leads.findOneAndUpdate(
      {
        phone,
        linkSentAt: { $exists: false },
        linkClaimedAt: { $exists: false },
        linkSendAttempts: { $lt: MAX_SEND_ATTEMPTS },
      },
      {
        $set: { linkClaimedAt: now, linkSendStatus: 'sending', ...(name ? { name } : {}) },
        $inc: { linkSendAttempts: 1 },
      },
      { returnDocument: 'after' },
    )

    if (!claimed) {
      const existing = await leads.findOne({ phone }, { projection: { leadId: 1, linkSentAt: 1, linkSendStatus: 1 } })
      return NextResponse.json({
        alreadySent: Boolean(existing?.linkSentAt),
        leadId: existing?.leadId ?? null,
        status: existing?.linkSendStatus ?? 'unknown',
      })
    }

    const outcome = await sendVslLink(phone, String(claimed.name || name))

    if (!outcome.ok) {
      if (outcome.definitive) {
        // Known not delivered: release the claim so it can be retried, and record nothing
        // that would start the reminder clock.
        await leads.updateOne(
          { phone },
          { $set: { linkSendStatus: 'failed', linkSendError: outcome.error }, $unset: { linkClaimedAt: '' } },
        )
      } else {
        // It may have gone out. Keep the claim so nothing retries automatically.
        await leads.updateOne({ phone }, { $set: { linkSendStatus: 'unknown', linkSendError: outcome.error } })
      }
      console.error('VSL link send failed', { phone, definitive: outcome.definitive, error: outcome.error })
      return NextResponse.json({ error: 'Send failed', definitive: outcome.definitive }, { status: 502 })
    }

    // linkSentAt is the fact; linkClaimedAt was only the mutex. Stamping the fact solely
    // after a confirmed send keeps the reminder clock from starting for a message that
    // never went out.
    const sentAt = new Date()
    await leads.updateOne(
      { phone },
      {
        $set: {
          linkSentAt: sentAt,
          linkSendStatus: 'sent',
          reminderState: 'due',
          reminderDueAt: new Date(sentAt.getTime() + reminderDelayMs()),
        },
        $max: { lastActivityAt: sentAt },
        $unset: { linkClaimedAt: '' },
      },
    )

    return NextResponse.json({ sent: true, leadId: claimed.leadId, reminderDueAt: new Date(sentAt.getTime() + reminderDelayMs()) })
  } catch (error) {
    console.error('VSL send-link failed', error)
    return NextResponse.json({ error: 'Send service unavailable' }, { status: 503 })
  }
}
