import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// TODO: auth integration pending V2-001-T2 (BetterAuth install)
// Session validation will be added in the auth plugin.

// '/' is intentionally omitted here — the root page handles its own redirect
// logic (setup vs login vs dashboard) because it needs DB access to check
// whether any users exist, which the Edge middleware cannot do.
const PUBLIC = new Set(['/', '/login', '/setup']);

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

  if (pathname.startsWith('/api/setup')) return addCors(NextResponse.next());
  if (pathname.startsWith('/api/health')) return addCors(NextResponse.next());
  if (pathname.startsWith('/api/metrics')) return addCors(NextResponse.next());
  if (extensionApi) return addCors(NextResponse.next());
  if (PUBLIC.has(pathname)) return NextResponse.next();

  // TODO: auth integration pending V2-001-T2 (BetterAuth install)
  // Session validation will be added in the auth plugin.
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon).*)'],
};
