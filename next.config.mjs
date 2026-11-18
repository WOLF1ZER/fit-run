/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',          // static site: works on any host and offline as a PWA
  images: { unoptimized: true },
  reactStrictMode: false,    // the game owns a single WebGL context; avoid double-mount in dev
};
export default nextConfig;
