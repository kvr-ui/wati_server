import path from 'node:path'
import type { NextConfig } from 'next'
const nextConfig: NextConfig = { reactStrictMode: true, outputFileTracingRoot: path.resolve(__dirname), devIndicators: false, images: { remotePatterns: [{ protocol: 'https', hostname: 'res.cloudinary.com' }] } }
export default nextConfig
