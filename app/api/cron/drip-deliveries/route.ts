import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cronAuth'
import { ALL_DRIPS } from '@/lib/drips'
import { checkDripDeliveries } from '@/dripcore/delivery'
import { runDripBatch } from '@/dripcore/runner'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Checks every campaign's recent template sends against WATI's message history, queues re-sends
// for the ones that never reached the lead, and then sends whatever is due.
//
// The send has to happen here rather than in each campaign's own cron because only NR has one:
// the brochure campaigns send instantly from the webhook and never run on a schedule, so a re-send
// queued for them would otherwise wait forever.
async function run(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const results = []
  for (const cfg of ALL_DRIPS) {
    try {
      const delivery = await checkDripDeliveries(cfg)
      const sent = await runDripBatch(cfg)
      results.push({ campaign: cfg.campaign.id, delivery, sent })
    } catch (error) {
      console.error(`${cfg.campaign.logTag} delivery check failed`, error)
      results.push({ campaign: cfg.campaign.id, error: 'delivery check failed' })
    }
  }
  return NextResponse.json({ results })
}

export async function POST(request: Request) {
  return run(request)
}

export async function GET(request: Request) {
  return run(request)
}
