import NextAuth from 'next-auth';
import authConfig from './auth.config';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { auth } = NextAuth(authConfig);

// '/' is intentionally omitted here — the root page handles its own redirect
// logic (setup vs login vs dashboard) because it needs DB access to check
// whether any users exist, which the Edge middleware cannot do.
const PUBLIC = new Set(['/', '/login', '/setup']);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/auth')) return NextResponse.next();
  if (pathname.startsWith('/api/setup')) return NextResponse.next();
  if (pathname.startsWith('/api/health')) return NextResponse.next();
  if (pathname.startsWith('/api/metrics')) return NextResponse.next(); // will be gated later
  if (pathname.startsWith('/api/v1/pair/challenge')) return NextResponse.next();
  if (pathname.startsWith('/api/v1/pair/status')) return NextResponse.next();
  // Extension-facing endpoints — use x-api-key auth inside the handler, no session needed.
  if (pathname.startsWith('/api/v1/items/awaiting-upload')) return NextResponse.next();
  if (pathname.startsWith('/api/v1/items/') && pathname.endsWith('/upload')) return NextResponse.next();
  if (PUBLIC.has(pathname)) return NextResponse.next();
  const session = await auth();
  if (!session) return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon).*)'],
};
