import { timingSafeEqual } from 'crypto'

// Cron routes are triggered by host cron against 127.0.0.1:3000, so they never traverse nginx.
// nginx should additionally deny /api/cron/ so they are unreachable from the internet even if the
// token leaks. No CORS headers anywhere in there — these are not for browsers.
//
// An unset CRON_SECRET denies everything rather than allowing it: a deploy that forgot the key
// should be a locked door, not an open one.
export function cronAuthorized(request: Request) {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const header = request.headers.get('authorization') || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
