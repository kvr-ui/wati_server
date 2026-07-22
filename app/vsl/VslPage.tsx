'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { LockKeyhole, Play, Volume2 } from 'lucide-react'

type EventType = 'play_started' | 'pause' | 'progress' | 'seek' | 'milestone' | 'completed' | 'page_exit'
type Range = [number, number]
type VslProps = { embedUrl: string; videoId: string; continueUrl: string }

function formatName(value: string) { return value.trim().split(/\s+/)[0] || 'future CA' }

export default function VslPage({ embedUrl, videoId }: VslProps) {
  const [name, setName] = useState('')
  const [leadId, setLeadId] = useState('')
  const [started, setStarted] = useState(Boolean(embedUrl))
  const [watched, setWatched] = useState(0)
  const [duration, setDuration] = useState(0)
  const ranges = useRef<Range[]>([])
  const milestones = useRef(new Set<number>())
  const sessionId = useMemo(() => crypto.randomUUID(), [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const incomingName = params.get('name') || ''
    const phone = params.get('phone') || ''
    setName(incomingName)
    if (incomingName || phone) window.history.replaceState({}, '', '/vsl')
    if (incomingName && phone) {
      fetch('/api/leads/resolve', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ name:incomingName, phone }) })
        .then((r) => r.ok ? r.json() : null).then((data) => data?.leadId && setLeadId(data.leadId)).catch(() => undefined)
    }
  }, [])

  function addRange(time: number) {
    if (!time) return
    const next: Range[] = []; const start = Math.max(0, time - 2); const end = time + 2
    for (const [a,b] of [...ranges.current, [start,end] as Range].sort((x,y) => x[0]-y[0])) { const last = next[next.length-1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else next.push([a,b]) }
    ranges.current = next; setWatched(Math.round(next.reduce((sum, [a,b]) => sum + b-a, 0)))
  }
  function track(eventType: EventType, currentTime = 0, milestone?: number) {
    addRange(currentTime)
    if (!leadId) return
    fetch('/api/vsl/events', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ leadId, videoId, eventType, currentTime, videoDuration:duration, watchedSeconds:watched, watchPercentage:duration ? watched / duration * 100 : 0, milestone, sessionId, occurredAt:new Date().toISOString() }) }).catch(() => undefined)
  }
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') track('page_exit') }
    const onMessage = (event: MessageEvent) => {
      if (embedUrl && event.origin !== new URL(embedUrl).origin) return
      const data = typeof event.data === 'string' ? (() => { try { return JSON.parse(event.data) } catch { return {} } })() : event.data || {}
      const current = Number(data.currentTime ?? data.time ?? 0)
      if (Number(data.duration) > 0) setDuration(Number(data.duration))
      const eventDuration = Number(data.duration) || duration
      if (eventDuration > 0 && current > 0) {
        for (const mark of [25, 50, 75, 90, 100]) {
          if (current / eventDuration * 100 >= mark && !milestones.current.has(mark)) {
            milestones.current.add(mark)
            track('milestone', current, mark)
          }
        }
      }
      if (data.event === 'play' || data.type === 'play') track(started ? 'progress' : 'play_started', current)
      else if (data.event === 'pause' || data.type === 'pause') track('pause', current)
      else if (data.event === 'seek' || data.type === 'seek') track('seek', current)
      else if (data.event === 'ended' || data.type === 'ended') track('completed', current)
      else if (current > 0) track('progress', current)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('message', onMessage)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('message', onMessage) }
  // The player communicates through postMessage; the handler intentionally uses the latest telemetry state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedUrl, leadId, started, watched, duration])

  return <main className="page flex min-h-screen items-center justify-center px-5 py-14"><div className="grain" />
    <div className="fade-up relative w-full max-w-[920px]">
      <p className="eyebrow mb-4 text-center">A note for {formatName(name)}</p>
      <div className="absolute -top-7 left-0 font-mono text-[10px] tracking-[.2em] text-[#71819c]">FOCAS / VSL-01</div>
      <div className="relative aspect-video w-full overflow-hidden border border-[#ff9a62]/50 bg-[#18243b] shadow-[0_30px_90px_rgba(0,0,0,.42)]"><div className="absolute inset-0 opacity-50" style={{backgroundImage:'linear-gradient(rgba(255,154,98,.14) 1px,transparent 1px),linear-gradient(90deg,rgba(255,154,98,.14) 1px,transparent 1px)',backgroundSize:'44px 44px'}} /><div className="absolute inset-0 bg-[radial-gradient(circle_at_60%_35%,rgba(255,154,98,.22),transparent_24%),linear-gradient(130deg,transparent_20%,rgba(10,16,32,.65))]" />{started && embedUrl && <iframe title="FOCAS introduction" className="absolute inset-0 z-10 h-full w-full" src={`${embedUrl}${embedUrl.includes('?') ? '&' : '?'}autoplay=true&preload=true&muted=true`} allow="autoplay; fullscreen; picture-in-picture" />}<div className={`absolute bottom-6 left-6 right-6 z-20 flex items-end justify-between text-left ${started && embedUrl ? 'pointer-events-none opacity-0' : ''}`}><div><p className="eyebrow mb-2">{embedUrl ? 'The complete CA journey' : 'Video setup required'}</p><p className="display max-w-[300px] text-3xl leading-none">{embedUrl ? <>A career built<br />with intention.</> : <>Add the Bunny<br />embed URL.</>}</p></div><button aria-label={started ? 'Video playing' : 'Play introduction'} onClick={() => { setStarted(true); track('play_started', 1) }} className="pointer-events-auto group flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[#ff9a62] text-[#0a1020] transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#f4f7fb]">{started ? <Volume2 size={20} /> : <Play className="ml-1" size={21} fill="currentColor" />}</button></div></div>
      <div className="mt-4 flex items-center justify-between text-left text-[10px] uppercase tracking-[.14em] text-[#71819c]"><span className="flex items-center gap-2"><LockKeyhole size={12} /> Private introduction</span><span>04:12 min</span></div>
    </div>
  </main>
}
