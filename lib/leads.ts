import { randomUUID } from 'crypto'
import { getDb } from './mongodb'

export async function resolveLead(name: string, phone: string) {
  const db = await getDb()
  const leads = db.collection('vsl_leads')
  const now = new Date()
  const existing = await leads.findOne({ phone })
  const leadId = existing?.leadId || randomUUID()
  await leads.updateOne({ phone }, { $set: { leadId, name, phone, source: 'onboarding_bot', lastActivityAt: now }, $setOnInsert: { createdAt: now, videoId: process.env.BUNNY_STREAM_VIDEO_ID || '' } }, { upsert: true })
  return leadId
}
