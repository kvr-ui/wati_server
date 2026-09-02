import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { runNrDripBatch, sweepStaleNrDripClaims } from '@/nrdrip/runner'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Triggered by host cron against 127.0.0.1:3000, so it never traverses nginx. nginx should
// additionally deny /api/cron/ so the route is unreachable from the internet even if the
// token leaks. No CORS headers — this is not for browsers.
function authorized(request: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const header = request.headers.get('authorization') || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function handle(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
