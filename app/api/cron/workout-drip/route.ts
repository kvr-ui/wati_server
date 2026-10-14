import { runDripCron } from '@/lib/dripCronRoute'
import { workoutConfig } from '@/workoutdrip'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  return runDripCron(workoutConfig, request)
}

// Allowed so the run can be inspected with a plain curl during setup.
export async function GET(request: Request) {
  return runDripCron(workoutConfig, request)
}
