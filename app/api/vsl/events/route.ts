import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { syncVslWatchTime } from '@/lib/bigin'
import { corsHeaders } from '@/lib/cors'

const eventTypes = new Set(['play_started','pause','progress','seek','milestone','completed','page_exit'])
const BIGIN_SYNC_MILESTONES = new Set([50, 90, 100])

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
    await db.collection('vsl_leads').updateOne({ leadId: event.leadId }, { $set: { lastActivityAt: now, lastEventType: event.eventType, watchedSeconds, watchPercentage } })

    const shouldSyncToBigin = event.eventType === 'page_exit' || (event.eventType === 'milestone' && BIGIN_SYNC_MILESTONES.has(Number(event.milestone)))
    if (shouldSyncToBigin && watchedSeconds > 0) {
      const lead = await db.collection('vsl_leads').findOne({ leadId: event.leadId }, { projection: { phone: 1 } })
      if (lead?.phone) {
        try { await syncVslWatchTime(lead.phone, watchedSeconds, watchPercentage) }
        catch (error) { console.error('Bigin watch-time sync failed', error) }
      }
    }

    return NextResponse.json({ ok: true }, { headers: corsHeaders() })
  } catch (error) { console.error('vsl event failed', error); return NextResponse.json({ error: 'Event service unavailable' }, { status: 503, headers: corsHeaders() }) }
}
