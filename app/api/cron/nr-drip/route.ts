import { runDripCron } from '@/lib/dripCronRoute'
import { nrConfig } from '@/nrdrip'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  return runDripCron(nrConfig, request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return runDripCron(nrConfig, request)
}
