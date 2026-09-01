import { randomUUID } from 'crypto'
import { getDb } from './mongodb'
import { sendVslLink } from './wati'

export type VslSendResult = {
  sent: boolean
  alreadySent: boolean
  leadId: string | null
  status: string
  error?: string
  definitive?: boolean
  reminderDueAt?: Date
}

const MAX_SEND_ATTEMPTS = 3

// A lead who completes the onboarding bot again should get the link again. Only sends inside
// this cooldown are suppressed — that is the window where a duplicate almost certainly means
// a webhook retry rather than a person genuinely going through the flow a second time.
function resendCooldownMs() {
  const hours = Number(process.env.VSL_RESEND_AFTER_HOURS)
  return (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 3600_000
}

// Minutes win when set, so the delay can be dialled down for testing without disturbing the
// production default.
function reminderDelayMs() {
  const minutes = Number(process.env.VSL_REMINDER_DELAY_MINUTES)
  if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60_000
  const hours = Number(process.env.VSL_REMINDER_DELAY_HOURS)
  return (Number.isFinite(hours) && hours >= 0 ? hours : 23) * 3600_000
}

// Sends the VSL link and records that it was sent, as one operation. Everything that delivers
// the link must go through here — a send that skips this leaves no linkSentAt, so no reminder
// is ever scheduled and the lead silently falls out of the follow-up.
export async function sendTrackedVslLink(phone: string, name: string): Promise<VslSendResult> {
  const db = await getDb()
  const leads = db.collection('vsl_leads')
  const now = new Date()

  // The lead may already exist from an earlier open, so only insert-time fields go here.
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
        // Seeded explicitly: the claim filters on $lt, which never matches a missing field.
        linkSendAttempts: 0,
      },
    },
    { upsert: true },
  )

  // Claim before sending. One atomic document operation is the whole idempotency guarantee:
  // whichever caller wins sends, everyone else is told it is already done. This absorbs a
  // webhook retry.
  const resendCutoff = new Date(now.getTime() - resendCooldownMs())
  const claimed = await leads.findOneAndUpdate(
    {
      phone,
      linkClaimedAt: { $exists: false },
      $and: [
        // The document may have been created by resolveLead (an open before any send), which
        // does not seed linkSendAttempts — and $lt never matches a missing field.
        { $or: [{ linkSendAttempts: { $exists: false } }, { linkSendAttempts: { $lt: MAX_SEND_ATTEMPTS } }] },
        // Never sent, or last sent long enough ago that this is a real second run.
        { $or: [{ linkSentAt: { $exists: false } }, { linkSentAt: { $lt: resendCutoff } }] },
      ],
    },
    { $set: { linkClaimedAt: now, linkSendStatus: 'sending', ...(name ? { name } : {}) }, $inc: { linkSendAttempts: 1 } },
    { returnDocument: 'after' },
  )

  if (!claimed) {
    const existing = await leads.findOne({ phone }, { projection: { leadId: 1, linkSentAt: 1, linkSendStatus: 1 } })
    return {
      sent: false,
      alreadySent: Boolean(existing?.linkSentAt),
      leadId: (existing?.leadId as string) ?? null,
      status: (existing?.linkSendStatus as string) ?? 'unknown',
    }
  }

  const outcome = await sendVslLink(phone, String(claimed.name || name))

  if (!outcome.ok) {
    if (outcome.definitive) {
      // Known not delivered: release the claim so it can be retried, and record nothing that
      // would start the reminder clock.
      await leads.updateOne(
        { phone },
        { $set: { linkSendStatus: 'failed', linkSendError: outcome.error }, $unset: { linkClaimedAt: '' } },
      )
    } else {
      // It may have gone out. Keep the claim so nothing retries automatically.
      await leads.updateOne({ phone }, { $set: { linkSendStatus: 'unknown', linkSendError: outcome.error } })
    }
    console.error('VSL link send failed', { phone, definitive: outcome.definitive, error: outcome.error })
    return { sent: false, alreadySent: false, leadId: String(claimed.leadId), status: outcome.definitive ? 'failed' : 'unknown', error: outcome.error, definitive: outcome.definitive }
  }

  // linkSentAt is the fact; linkClaimedAt was only the mutex. Stamping it solely after a
  // confirmed send keeps the reminder clock from starting for a message that never went out.
  const sentAt = new Date()
  const reminderDueAt = new Date(sentAt.getTime() + reminderDelayMs())
  await leads.updateOne(
    { phone },
    {
      // linkSendAttempts counts CONSECUTIVE failures, so a success clears it — otherwise a
      // lead who legitimately receives the link three times could never be sent it again.
      $set: { linkSentAt: sentAt, linkSendStatus: 'sent', reminderState: 'due', reminderDueAt, linkSendAttempts: 0 },
      $max: { lastActivityAt: sentAt },
      $unset: { linkClaimedAt: '' },
    },
  )

  return { sent: true, alreadySent: false, leadId: String(claimed.leadId), status: 'sent', reminderDueAt }
}
