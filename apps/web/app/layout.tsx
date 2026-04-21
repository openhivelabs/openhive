import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OpenHive',
  description: 'AI agent company orchestrator',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
