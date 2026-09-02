import { runDripCron } from '@/lib/dripCronRoute'
import { foundationConfig } from '@/foundationdrip'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  return runDripCron(foundationConfig, request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return runDripCron(foundationConfig, request)
}
