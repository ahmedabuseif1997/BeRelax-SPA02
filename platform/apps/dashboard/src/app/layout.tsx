import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'BE RELAX — Reception',
  description: 'Booking grid, check-in and checkout for BE RELAX Massage Center and Spa.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The desk taps the same buttons all night; a stray double-tap must not zoom.
  maximumScale: 1,
  themeColor: '#FBF6EF',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <head>
        {/* The site's own typefaces, loaded the same way index.html loads them.
            Linked rather than bundled with next/font so a build needs no network
            and an offline iPad simply falls back to the system stack. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Jost:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
