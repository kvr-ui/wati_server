import { runDripCron } from '@/lib/dripCronRoute'
import { kitConfig } from '@/kitdrip'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  return runDripCron(kitConfig, request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return runDripCron(kitConfig, request)
}
