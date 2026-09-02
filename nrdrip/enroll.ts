import { getDb } from '@/lib/mongodb'
import { CAMPAIGN, COLLECTION, cancelOnTagChange, dueAtForStep, reenrollCooldownMs } from './config'
import type { CallOutcome, EnrollResult, NrDripCancelReason, NrDripState } from './types'

const ACTIVE_STATES: NrDripState[] = ['due', 'claimed']

// What we copy off the lead at enrolment, so the drip can personalise its copy and so
// Followup_dashboard can report on it without a join.
async function leadSnapshot(phone: string) {
  const db = await getDb()
  const lead = await db.collection('vsl_leads').findOne(
    { phone },
    { projection: { leadId: 1, name: 1, watchPercentage: 1 } },
  )
  return {
    leadId: (lead?.leadId as string) ?? null,
    name: (lead?.name as string) || '',
    watchPercentage: typeof lead?.watchPercentage === 'number' ? lead.watchPercentage : null,
  }
}

// When the previous drip stopped running. Cancelled and completed stamp their own time; a run
// parked as failed/window_closed/stuck stamps neither, so the last message it managed to send
// is the closest honest answer, and enrolment time is the last resort.
function dripEndedAt(doc: Record<string, unknown>): Date | undefined {
  if (doc.cancelledAt instanceof Date) return doc.cancelledAt
  if (doc.completedAt instanceof Date) return doc.completedAt
  const steps = Array.isArray(doc.steps) ? doc.steps : []
  const last = steps[steps.length - 1] as { sentAt?: unknown } | undefined
  if (last?.sentAt instanceof Date) return last.sentAt
  if (doc.enrolledAt instanceof Date) return doc.enrolledAt
  return undefined
}

// Ends a drip early. Used by the runner when the lead replies, and by the webhook when sales
// finally connects. Only matches an active drip, so it can never resurrect or overwrite a
// sequence that already reached a terminal state.
export async function cancelDrip(phone: string, reason: NrDripCancelReason) {
  const db = await getDb()
  const res = await db.collection(COLLECTION).updateOne(
    { phone, state: { $in: ACTIVE_STATES } },
    { $set: { state: 'cancelled', cancelledAt: new Date(), cancelReason: reason }, $unset: { claimedAt: '' } },
  )
  return res.modifiedCount > 0
}

// The single entry point for everything the Bigin call webhook reports.
//
// Every branch that touches an existing drip is a filtered update rather than a read followed
// by a write, so two webhooks racing for the same lead cannot clobber each other's state.
export async function enrollFromCallOutcome(call: CallOutcome): Promise<EnrollResult> {
  const db = await getDb()
  const drips = db.collection(COLLECTION)
  const now = new Date()
  const { phone, callId } = call

  const addCallId = callId ? { $addToSet: { sourceCallIds: callId } } : {}

  // NOTE: callId here is Bigin's CONTACT id (${trigger.id}), which is the same for every
  // webhook about that person — so it cannot be used to recognise a replay. Treating a repeat
  // id as a duplicate silently swallowed the "sales connected" webhook and left the drip
  // running. The ids are recorded for audit only; idempotency comes from the state machine
  // below, which already absorbs repeats: a repeat while active is `already_active`, and a
  // repeat after the drip ended is `cooldown`.

  // The lead now carries a different tag, so they belong to that tag's campaign rather than
  // this one. We cannot tell from here whether it means sales connected, the lead was closed,
  // or something else — only that they are no longer NR — so the reason records the fact
  // (the tag changed) rather than guessing at intent.
  if (!call.isNoResponse) {
    if (!cancelOnTagChange()) {
      await drips.updateOne({ phone }, { $set: { lastCallAt: now }, ...addCallId })
      return { action: 'ignored', phone, detail: 'NR_DRIP_CANCEL_ON_TAG_CHANGE is false' }
    }
    const res = await drips.updateOne(
      { phone, state: { $in: ACTIVE_STATES } },
      {
        $set: { state: 'cancelled', cancelledAt: now, cancelReason: 'tag_changed', lastCallAt: now },
        $unset: { claimedAt: '' },
        ...addCallId,
      },
    )
    if (res.modifiedCount > 0) return { action: 'cancelled', phone, state: 'cancelled', detail: call.outcome }
    // Nothing active to stop; still file the call id so a retry is recognised as a replay.
    await drips.updateOne({ phone }, { $set: { lastCallAt: now }, ...addCallId })
    return { action: 'ignored', phone, detail: `no active drip for outcome "${call.outcome}"` }
  }

  // Sales typically try the same lead several times. Each further attempt is recorded, but the
  // sequence keeps its original schedule — a third call must not push the lead back to step 0.
  const active = await drips.updateOne(
    { phone, state: { $in: ACTIVE_STATES } },
    { $inc: { callAttempts: 1 }, $set: { lastCallAt: now }, ...addCallId },
  )
  if (active.matchedCount > 0) {
    const doc = await drips.findOne({ phone }, { projection: { state: 1, step: 1, dueAt: 1 } })
    return { action: 'already_active', phone, state: doc?.state as NrDripState, step: Number(doc?.step ?? 0), dueAt: doc?.dueAt as Date }
  }

  const existing = await drips.findOne(
    { phone },
    { projection: { enrolledAt: 1, state: 1, steps: 1, cancelledAt: 1, completedAt: 1 } },
  )

  // The cooldown exists so a lead is not messaged again too soon, which means it is about when
  // the last drip ENDED — not when it started — and it only applies if that drip actually sent
  // something.
  //
  // A drip that messaged nobody cannot have been too much contact. The usual cause is a tag
  // applied and taken straight off again; measuring from enrolledAt used to lock that lead out
  // for a week, which reads from the sales desk as the automation being broken. Once a message
  // has gone out the cooldown applies normally, so repeated tagging still cannot spam anyone.
  const sentCount = Array.isArray(existing?.steps) ? existing.steps.length : 0
  if (existing && sentCount > 0) {
    const endedAt = dripEndedAt(existing)
    if (endedAt && now.getTime() - endedAt.getTime() < reenrollCooldownMs()) {
      await drips.updateOne({ phone }, { $set: { lastCallAt: now }, ...addCallId })
      return { action: 'cooldown', phone, state: existing.state as NrDripState, detail: 'within NR_DRIP_REENROLL_AFTER_HOURS' }
    }
  }

  const dueAt = dueAtForStep(now, 0)
  if (!dueAt) return { action: 'ignored', phone, detail: 'no drip steps configured' }

  const snapshot = await leadSnapshot(phone)

  await drips.updateOne(
    { phone },
    {
      $set: {
        leadId: snapshot.leadId,
        // The lead's own name wins; the webhook's is only a fallback for someone who never
        // reached the VSL.
        name: snapshot.name || call.name || '',
        watchPercentageAtEnroll: snapshot.watchPercentage,
        enrolledAt: now,
        state: 'due',
        step: 0,
        dueAt,
        steps: [],
        attempts: 0,
        lastCallAt: now,
      },
      // A re-enrolment must not inherit the previous run's failure diagnostics.
      $unset: { claimedAt: '', lastError: '', cancelledAt: '', cancelReason: '' },
      $inc: { callAttempts: 1 },
      $setOnInsert: { phone, campaign: CAMPAIGN },
      ...addCallId,
    },
    { upsert: true },
  )

  return { action: existing ? 'reenrolled' : 'enrolled', phone, state: 'due', step: 0, dueAt }
}
