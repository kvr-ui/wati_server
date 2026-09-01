import { randomUUID } from 'crypto'
import { getDb } from './mongodb'

export type ResolvedLead = { leadId: string; name: string }

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

  // Cancel a pending reminder as a separate, narrowly filtered update. Filtering on 'due'
  // means an open cannot clobber 'claimed' or 'sent' — a lead who opens 30 hours later must
  // not erase the record that a reminder already went out.
  await leads.updateOne(
    { phone, reminderState: 'due' },
    { $set: { reminderState: 'cancelled', reminderCancelledAt: now } },
  )

  return { leadId: String(doc?.leadId || ''), name: String(doc?.name || '') }
}
