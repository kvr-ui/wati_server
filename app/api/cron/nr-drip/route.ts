import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cronAuth'
import { runNrDripBatch, sweepStaleNrDripClaims } from '@/nrdrip'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function handle(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'
  try {
    const stale = dryRun ? null : await sweepStaleNrDripClaims()
    const result = await runNrDripBatch({ dryRun })
    return NextResponse.json({ ...result, stale })
  } catch (error) {
    console.error('NR drip run failed', error)
    return NextResponse.json({ error: 'NR drip run failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return handle(request)
}
