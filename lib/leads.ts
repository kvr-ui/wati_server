import { randomUUID } from 'crypto'
import { getDb } from './mongodb'

export type ResolvedLead = { leadId: string; name: string }

// Filtering on 'due' means this cannot clobber 'claimed' or 'sent' — a lead who engages long
// after the fact must not erase the record that a reminder already went out.
export async function cancelPendingReminder(match: { phone?: string; leadId?: string }) {
  const db = await getDb()
  const filter = match.phone ? { phone: match.phone } : { leadId: match.leadId }
  await db.collection('vsl_leads').updateOne(
    { ...filter, reminderState: 'due' },
    { $set: { reminderState: 'cancelled', reminderCancelledAt: new Date() } },
  )
}

// Called when a lead actually opens the VSL page. This is the "opened" signal the reminder
// job keys on, so it must never disturb what the send path recorded.
//
// Operator choices matter here:
//   $min on firstOpenedAt  — sets the field when absent, only lowers it when present, so the
//                            first open wins regardless of arrival order and re-mounts are free.
//   $max on lastActivityAt — a delayed or clock-skewed write cannot rewind it.
//   leadId in $setOnInsert — the old findOne-then-$set could mint a second UUID under a race
//                            and orphan the first, after which /api/vsl/events (which matches
//                            on leadId with no upsert) would silently update nothing.
//   name only when non-empty — a template-button link carries just the phone, and must not
//                            blank the name the send path stored.
export async function resolveLead(phone: string, name?: string): Promise<ResolvedLead> {
  const db = await getDb()
  const leads = db.collection('vsl_leads')
  const now = new Date()
  const trimmed = (name || '').trim().slice(0, 100)

  const insert: Record<string, unknown> = {
    leadId: randomUUID(),
    phone,
    createdAt: now,
    videoId: process.env.BUNNY_STREAM_VIDEO_ID || '',
    source: 'vsl_page',
  }
  // name lives in exactly one operator — Mongo rejects the same path in $set and $setOnInsert.
  if (!trimmed) insert.name = ''

  const doc = await leads.findOneAndUpdate(
    { phone },
    {
      $setOnInsert: insert,
      ...(trimmed ? { $set: { name: trimmed } } : {}),
      $min: { firstOpenedAt: now },
      $max: { lastOpenedAt: now, lastActivityAt: now },
      $inc: { openCount: 1 },
    },
    { upsert: true, returnDocument: 'after' },
  )

  // Whether merely OPENING the page is enough to call off the reminder, or whether the lead
  // has to actually press play. The reminder copy says "you didn't watch the video", so the
  // default is 'play' — opening and bouncing should still be chased.
  if ((process.env.VSL_REMINDER_CANCEL_ON || 'play') === 'open') await cancelPendingReminder({ phone })

  return { leadId: String(doc?.leadId || ''), name: String(doc?.name || '') }
}
