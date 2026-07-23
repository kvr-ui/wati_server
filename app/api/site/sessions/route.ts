import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { corsHeaders } from '@/lib/cors'
import { syncSiteSession } from '@/lib/bigin'

const events = new Set(['start', 'ping', 'end'])
const BIGIN_SYNC_THROTTLE_MS = 20_000

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (typeof body.sessionId !== 'string' || !body.sessionId || !events.has(body.event)) return NextResponse.json({ error: 'Invalid session event' }, { status: 400, headers: corsHeaders() })
    const now = new Date()
    const activeSeconds = Math.max(0, Math.round(Number(body.activeSeconds) || 0))
    const totalSeconds = Math.max(0, Math.round(Number(body.totalSeconds) || 0))
    const path = typeof body.path === 'string' ? body.path.slice(0, 300) : ''
    const leadId = typeof body.leadId === 'string' ? body.leadId : null
    const referrer = typeof body.referrer === 'string' ? body.referrer.slice(0, 500) : ''
    const userAgent = request.headers.get('user-agent')?.slice(0, 400) || ''

    const db = await getDb()
    const sessions = db.collection('site_sessions')
    await sessions.updateOne(
      { sessionId: body.sessionId },
      {
        $set: { lastSeenAt: now, lastPath: path, ...(leadId ? { leadId } : {}), ...(body.event === 'end' ? { endedAt: now } : {}) },
        $max: { activeSeconds, totalSeconds },
        $setOnInsert: { sessionId: body.sessionId, startedAt: now, referrer, userAgent, firstPath: path },
      },
      { upsert: true },
    )

    // On exit, push the visitor's time-on-site to their Bigin contact as a note.
    // Only for identified sessions (leadId), and throttled so repeated exit beacons
    // update the same note at most once per throttle window instead of spamming.
    if (body.event === 'end' && leadId && activeSeconds > 0) {
      try {
        const doc = await sessions.findOne({ sessionId: body.sessionId }, { projection: { biginNoteId: 1, biginSyncedAt: 1, leadId: 1 } })
        const lastSync = doc?.biginSyncedAt ? new Date(doc.biginSyncedAt).getTime() : 0
        if (now.getTime() - lastSync >= BIGIN_SYNC_THROTTLE_MS) {
          const lead = await db.collection('vsl_leads').findOne({ leadId: doc?.leadId || leadId }, { projection: { phone: 1 } })
          if (lead?.phone) {
            const minutes = (activeSeconds / 60).toFixed(1)
            const when = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            const content = `Website session: ${minutes} min active on site (last page: ${path || '/'}) as of ${when}`
            const noteId = await syncSiteSession(lead.phone, doc?.biginNoteId as string | undefined, content)
            await sessions.updateOne({ sessionId: body.sessionId }, { $set: { biginSyncedAt: new Date(), ...(noteId ? { biginNoteId: noteId } : {}) } })
          }
        }
      } catch (error) { console.error('site session Bigin sync failed', error) }
    }

    return NextResponse.json({ ok: true }, { headers: corsHeaders() })
  } catch (error) {
    console.error('site session failed', error)
    return NextResponse.json({ error: 'Session service unavailable' }, { status: 503, headers: corsHeaders() })
  }
}
