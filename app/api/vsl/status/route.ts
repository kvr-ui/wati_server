import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
export async function GET(request: Request) {
  try { const id = new URL(request.url).searchParams.get('leadId'); if (!id) return NextResponse.json({ error: 'Missing leadId' }, { status: 400 }); const lead = await (await getDb()).collection('vsl_leads').findOne({ leadId: id }, { projection: { _id: 0, watchedSeconds: 1, watchPercentage: 1 } }); return NextResponse.json(lead || {}) } catch { return NextResponse.json({}) }
}
