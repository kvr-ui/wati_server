import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { syncVslWatchTime } from '@/lib/bigin'
import { corsHeaders } from '@/lib/cors'

const eventTypes = new Set(['play_started','pause','progress','seek','milestone','completed','page_exit'])
const BIGIN_SYNC_EVENTS = new Set(['progress', 'milestone', 'completed', 'page_exit'])

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(request: Request) {
  try {
    const event = await request.json()
    if (typeof event.leadId !== 'string' || typeof event.videoId !== 'string' || !eventTypes.has(event.eventType)) return NextResponse.json({ error: 'Invalid event' }, { status: 400, headers: corsHeaders() })
    const now = new Date()
    const db = await getDb()
    const watchedSeconds = Math.max(0, Number(event.watchedSeconds) || 0)
    const watchPercentage = Number(event.watchPercentage) || 0
    await db.collection('vsl_events').insertOne({ ...event, currentTime: Math.max(0, Number(event.currentTime) || 0), videoDuration: Math.max(0, Number(event.videoDuration) || 0), watchedSeconds, receivedAt: now })
    // $max on lastActivityAt so a delayed beacon cannot rewind it; $min on firstPlayAt so the
    // earliest play wins (the button handler and the Player.js 'play' event both fire one).
    await db.collection('vsl_leads').updateOne(
      { leadId: event.leadId },
      {
        $set: { lastEventType: event.eventType, watchedSeconds, watchPercentage },
        $max: { lastActivityAt: now },
        ...(event.eventType === 'play_started' ? { $min: { firstPlayAt: now } } : {}),
      },
    )

    if (BIGIN_SYNC_EVENTS.has(event.eventType) && watchedSeconds > 0) {
      const lead = await db.collection('vsl_leads').findOne({ leadId: event.leadId }, { projection: { phone: 1, vslNoteId: 1 } })
      if (lead?.phone) {
        try {
          const noteId = await syncVslWatchTime(lead.phone, watchedSeconds, watchPercentage, lead.vslNoteId)
          if (noteId && noteId !== lead.vslNoteId) await db.collection('vsl_leads').updateOne({ leadId: event.leadId }, { $set: { vslNoteId: noteId } })
        } catch (error) { console.error('Bigin watch-time sync failed', error) }
      }
    }

    return NextResponse.json({ ok: true }, { headers: corsHeaders() })
  } catch (error) { console.error('vsl event failed', error); return NextResponse.json({ error: 'Event service unavailable' }, { status: 503, headers: corsHeaders() }) }
}
