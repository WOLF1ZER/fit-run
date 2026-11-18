'use client';

import dynamic from 'next/dynamic';

// three.js needs the browser: load the game client-side only
const Game = dynamic(() => import('@/components/Game'), { ssr: false });

export default function Page() {
  return <Game />;
}
