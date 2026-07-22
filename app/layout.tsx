import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'The Complete CA Journey | FOCAS EduTech',
  description: 'A deliberate path to becoming a Chartered Accountant.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>
}
