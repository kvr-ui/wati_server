import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cronAuth'
import { runIntermediateDripBatch, sweepStaleIntermediateDripClaims } from '@/intermediatedrip'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// A separate route from nr-drip on purpose: the two campaigns are enabled, paced and paused
// independently, and a lead can be in both. Offset this one's cron line by a few minutes so a
// lead tagged NR *and* Intermediate does not get both messages in the same instant.
async function handle(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'
  try {
    const stale = dryRun ? null : await sweepStaleIntermediateDripClaims()
    const result = await runIntermediateDripBatch({ dryRun })
    return NextResponse.json({ ...result, stale })
  } catch (error) {
    console.error('Intermediate drip run failed', error)
    return NextResponse.json({ error: 'Intermediate drip run failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return handle(request)
}
