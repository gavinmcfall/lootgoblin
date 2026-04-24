import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Next.js Edge Middleware — V2-001-T4
 *
 * Handles:
 *   1. CORS preflight for extension-facing API endpoints.
 *   2. Session-based redirect to /login for protected pages.
 *   3. CORS headers on extension API responses.
 *
 * NOTE: BetterAuth session validation at the Edge requires the BetterAuth
 * session cookie. The full session check is done here for navigation requests
 * (page routes). API routes perform their own session validation using
 * auth.api.getSession() in the route handler.
 *
 * '/' is included in the PUBLIC set so the root server component can run
 * unauthenticated; it calls getFirstRunState() and redirects accordingly
 * (setup vs login vs dashboard). This DB-backed check cannot run at the Edge,
 * which is why the decision is pushed into the root page instead.
 */

// Publicly accessible paths — no session required.
const PUBLIC = new Set(['/', '/login', '/setup']);

// Auth routes handled by BetterAuth catch-all handler.
function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith('/api/auth');
}

// Extension-facing endpoints that (a) bypass session check and (b) need CORS so
// content scripts on third-party origins (e.g. makerworld.com) can reach them.
function isExtensionApi(pathname: string): boolean {
  return (
    pathname.startsWith('/api/v1/pair/challenge') ||
    pathname.startsWith('/api/v1/pair/status') ||
    pathname.startsWith('/api/v1/items/awaiting-upload') ||
    (pathname.startsWith('/api/v1/items/') && pathname.endsWith('/upload')) ||
    pathname.startsWith('/api/v1/site-configs') ||
    pathname.startsWith('/api/v1/sources') ||
    pathname.startsWith('/api/v1/source-credentials/') ||
    pathname === '/api/v1/queue'
  );
}

/**
 * Federation / Courier identity endpoint — always public.
 * Couriers and future federation peers reach this before they have credentials.
 * (V2-001-T6)
 */
function isInstanceEndpoint(pathname: string): boolean {
  return pathname === '/api/v1/instance';
}

/**
 * Setup status endpoint — always public.
 * Reachable before any user exists so the UI can determine first-run state.
 * (V2-001-T8)
 */
function isSetupStatusEndpoint(pathname: string): boolean {
  return pathname === '/api/v1/setup/status';
}

/**
 * Setup wizard endpoint — public during first-run only.
 * The route handler itself enforces the needsSetup gate.
 * (V2-001-T8)
 */
function isSetupWizardEndpoint(pathname: string): boolean {
  return pathname === '/api/v1/setup/wizard';
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'access-control-allow-headers': 'content-type, x-api-key, authorization',
  'access-control-max-age': '86400',
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const extensionApi = isExtensionApi(pathname);

  // CORS preflight for extension endpoints — respond directly, skip the handler.
  if (extensionApi && req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  const addCors = (res: NextResponse): NextResponse => {
    if (extensionApi) {
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    }
    return res;
  };

  // Always-public routes — pass through unconditionally.
  if (pathname.startsWith('/api/setup')) return addCors(NextResponse.next());
  if (pathname.startsWith('/api/health')) return addCors(NextResponse.next());
  if (pathname.startsWith('/api/metrics')) return addCors(NextResponse.next());
  if (isAuthRoute(pathname)) return addCors(NextResponse.next());
  if (isInstanceEndpoint(pathname)) return NextResponse.next();
  if (isSetupStatusEndpoint(pathname)) return NextResponse.next();
  if (isSetupWizardEndpoint(pathname)) return NextResponse.next();
  if (extensionApi) return addCors(NextResponse.next());
  if (PUBLIC.has(pathname)) return NextResponse.next();

  // For page navigation requests, redirect unauthenticated users.
  // BetterAuth session cookies are httpOnly, so we check for the presence of the
  // better-auth.session_token cookie as a fast proxy for "has a session".
  // The definitive check is in the layout (auth.api.getSession); this redirect
  // just avoids an uncached round-trip to the layout for obviously-unauthed users.
  //
  // API routes perform their own auth checks in the route handler; we skip the
  // redirect for those.
  if (!pathname.startsWith('/api/')) {
    const sessionCookie =
      req.cookies.get('better-auth.session_token') ??
      req.cookies.get('__Secure-better-auth.session_token');
    if (!sessionCookie) {
      const loginUrl = new URL('/login', req.url);
      loginUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return addCors(NextResponse.next());
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon).*)'],
};
