import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getDb } from '@/lib/mongodb'
import { normalizePhone } from '@/lib/phone'
import { onboardingDelayMs } from '@/lib/vslSend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// WATI's messageReceived webhook: fires the moment a lead sends us anything, including a tap on a
// template's quick-reply button.
//
// That tap is the pivot of the whole flow — it is when WATI sends the lead the tracked VSL link,
// and it is what opens the 24h window the chatbot API needs. Without this endpoint the job has to
// poll WATI for every waiting lead every 30 minutes to notice it. With it, the tap is known the
// instant it happens and the bot is scheduled to the second.
//
// The poller in lib/onboardingBot.ts is deliberately LEFT IN PLACE as the backstop: a webhook that
// is misconfigured, briefly unreachable, or silently switched off in WATI would otherwise strand
// every lead in `waiting` with nothing to notice it. Both paths make the same state transition and
// only one can win it, so running both costs nothing but a wasted update.
//
// WATI signs nothing, so the shared secret goes in the URL WATI is configured to call:
//   https://.../api/webhooks/wati-inbound?token=<WATI_WEBHOOK_TOKEN>
// An unset token denies everything rather than allowing it — a deploy that forgot the key should
// be a locked door, not an open one, since this endpoint moves leads into a sending queue.
function authorized(request: Request) {
  const expected = process.env.WATI_WEBHOOK_TOKEN
  if (!expected) return false
  const url = new URL(request.url)
  const header = request.headers.get('authorization') || ''
  const provided = url.searchParams.get('token') || (header.startsWith('Bearer ') ? header.slice(7) : '')
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// WATI sends the message time as unix seconds, unix milliseconds or an ISO string depending on the
// event. Anything unparseable falls back to the caller's `now` — being a few hundred milliseconds
// out matters far less than dropping the tap.
function parseTimestamp(raw: unknown, now: Date): Date {
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) {
    const n = Number(raw)
    const ms = n > 1e12 ? n : n * 1000
    const d = new Date(ms)
    if (Number.isFinite(d.getTime())) return d
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return new Date(parsed)
  }
  return now
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // `owner: true` is a message WE sent — echoed back on some event types. Acting on it would let
  // our own outbound message masquerade as the lead's tap and start the clock immediately.
  if (body.owner === true) return NextResponse.json({ ok: true, ignored: 'outbound' })

  const eventType = String(body.eventType ?? '')
  // Delivery/read receipts arrive on the same hook. Only an actual inbound message counts.
  if (eventType && !/message.?received|received.?message/i.test(eventType)) {
    return NextResponse.json({ ok: true, ignored: eventType })
  }

  const phone = normalizePhone(body.waId ?? body.whatsappNumber ?? body.phone)
  if (!phone) return NextResponse.json({ ok: true, ignored: 'no usable waId' })

  const now = new Date()
  const tappedAt = parseTimestamp(body.timestamp ?? body.created, now)
  // A clock-skewed or malformed future timestamp would push the bot arbitrarily far out.
  const tapAt = tappedAt.getTime() > now.getTime() ? now : tappedAt

  try {
    const db = await getDb()
    // Only a lead who is WAITING for their tap moves. Filtering on that state is what makes this
    // idempotent: every later message from the same lead matches nothing, so a chatty lead cannot
    // reschedule a bot that is already due, claimed or sent.
    const res = await db.collection('vsl_leads').updateOne(
      { phone, onboardingState: 'waiting' },
      {
        $set: {
          onboardingState: 'due',
          onboardingTappedAt: tapAt,
          onboardingDueAt: new Date(tapAt.getTime() + onboardingDelayMs()),
          onboardingTapSource: 'webhook',
        },
        $max: { lastActivityAt: now },
        $unset: { onboardingCheckAt: '' },
      },
    )

    if (res.modifiedCount) {
      console.log('WATI inbound: tap recorded', { phone, tapAt: tapAt.toISOString(), text: String(body.text ?? '').slice(0, 60) })
    }
    return NextResponse.json({ ok: true, scheduled: res.modifiedCount === 1 })
  } catch (error) {
    console.error('WATI inbound webhook failed', error)
    // 500 so WATI retries: losing a tap means the lead waits for the 30-minute poller instead.
    return NextResponse.json({ error: 'Inbound handling failed' }, { status: 500 })
  }
}
