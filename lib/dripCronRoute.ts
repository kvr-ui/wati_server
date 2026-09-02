import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cronAuth'
import type { DripConfig } from '@/dripcore/config'
import { runDripBatch, sweepStaleClaims } from '@/dripcore/runner'

// One campaign's cron tick. Every campaign's route is the same eight lines around this call, so
// adding a fifth drip does not mean a fifth copy of the auth check and the error handling.
//
// Each campaign keeps its OWN route rather than sharing one parameterised URL, because that is
// what lets you enable, pace and pause them independently — and offset their cron lines so two
// campaigns never message the same lead in the same instant.
export async function runDripCron(cfg: DripConfig, request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1'
  try {
    const stale = dryRun ? null : await sweepStaleClaims(cfg)
    const result = await runDripBatch(cfg, { dryRun })
    return NextResponse.json({ ...result, stale })
  } catch (error) {
    console.error(`${cfg.campaign.logTag} run failed`, error)
    return NextResponse.json({ error: `${cfg.campaign.id} drip run failed` }, { status: 500 })
  }
}
