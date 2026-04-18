import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-compatible Auth.js configuration.
 *
 * This file MUST NOT import anything that requires Node.js native modules
 * (e.g. better-sqlite3, argon2, drizzle). It is imported by both the full
 * auth instance (src/auth/index.ts) and by the middleware, which runs on the
 * Edge runtime.
 *
 * The secret is read directly from process.env here rather than via the Zod
 * env module to avoid pulling Node-only dependencies into the edge bundle.
 * process.env is available in both Node and the Next.js Edge runtime.
 */
const authConfig = {
  providers: [],
  secret: process.env.AUTH_SECRET ?? process.env.LOOTGOBLIN_SECRET,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    jwt({ token, user }) {
      if (user) token.role = (user as { role?: string }).role ?? 'viewer';
      return token;
    },
    session({ session, token }) {
      (session.user as { role?: string }).role = token.role as string;
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
