import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cronAuth'
import { runOnboardingBotBatch, sweepStaleOnboardingClaims } from '@/lib/onboardingBot'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function handle(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'
  try {
    const stale = dryRun ? null : await sweepStaleOnboardingClaims()
    const result = await runOnboardingBotBatch({ dryRun })
    return NextResponse.json({ ...result, stale })
  } catch (error) {
    console.error('Onboarding bot run failed', error)
    return NextResponse.json({ error: 'Onboarding bot run failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return handle(request)
}
