import VslPage from './vsl/VslPage'

export const dynamic = 'force-dynamic'

export default function Home() {
  return <VslPage embedUrl={process.env.BUNNY_STREAM_EMBED_URL || ''} videoId={process.env.BUNNY_STREAM_VIDEO_ID || ''} continueUrl={process.env.NEXT_PUBLIC_BOT_CONTINUE_URL || '#apply'} />
}
