/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Keep native server-side modules out of the webpack bundle.  This also
  // prevents webpack from trying to statically resolve `new URL('./migrations',
  // import.meta.url)` inside db/client.ts during the build — which would fail
  // because webpack treats the first argument as a module path.
  serverExternalPackages: ['better-sqlite3', 'argon2', 'postgres'],
  eslint: {
    // ESLint config is not yet wired up for Next.js (tracked separately).
    // Disable the lint step during `next build` so that compilation errors
    // surface clearly without being masked by parser-level lint failures.
    ignoreDuringBuilds: true,
  },
};
export default nextConfig;
