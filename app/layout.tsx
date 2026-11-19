import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FIT RUN',
  description: 'Endless 3D fitness runner: grab protein shakes, stay hydrated, grow into a beast.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'FIT RUN', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#14110f',
};

// Production builds work offline (service worker precaches every file). In `npm run dev` any old worker is removed,
// so development never serves a stale cached build.
const registerSW = process.env.NODE_ENV === 'production' ? `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      const mark = () => { try { localStorage.setItem('fitrun.offline', '1'); } catch (e) {} window.dispatchEvent(new Event('fitrun-offline-ready')); };
      if (navigator.serviceWorker.controller) mark(); else navigator.serviceWorker.addEventListener('controllerchange', mark);
    }).catch(() => {});
  });
}` : `
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.startsWith('fitrun-')).forEach((k) => caches.delete(k)));`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: registerSW }} />
      </body>
    </html>
  );
}
