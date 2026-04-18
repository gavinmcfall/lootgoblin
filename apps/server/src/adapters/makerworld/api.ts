// Use the global fetch (Node 22 native / msw-patchable) rather than importing
// undici directly, so integration tests via msw can intercept calls.
// undici is declared as a dependency so bundlers can polyfill on older runtimes.

// ── Error classes ──────────────────────────────────────────────────────────

export class CredentialInvalidError extends Error {
  name = 'CredentialInvalidError' as const;
  retryable = false as const;
  constructor() { super('credential invalid'); }
}

export class PermissionDeniedError extends Error {
  name = 'PermissionDeniedError' as const;
  retryable = false as const;
  constructor() { super('permission denied'); }
}

export class NotFoundError extends Error {
  name = 'NotFoundError' as const;
  retryable = false as const;
  constructor() { super('not found'); }
}

export class RateLimitedError extends Error {
  name = 'RateLimitedError' as const;
  retryable = true as const;
  constructor(public retryAfterMs: number) { super('rate limited'); }
}

export class TransientError extends Error {
  name = 'TransientError' as const;
  retryable = true as const;
  constructor(status: number) { super(`transient error: HTTP ${status}`); }
}

// ── Cookie helpers ─────────────────────────────────────────────────────────

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
}

/**
 * Filter a cookie jar by domain (exact match on host, or any subdomain match) and
 * join as a single Cookie header value. Handles both `.makerworld.com` (leading dot
 * for subdomains) and `makerworld.com` (exact host) — real cookie jars contain both.
 */
export function buildCookieHeader(
  jar: CookieEntry[],
  domainSuffix = '.makerworld.com',
): string {
  const bareHost = domainSuffix.replace(/^\./, '');
  return jar
    .filter(c => {
      const d = c.domain.replace(/^\./, '');
      return d === bareHost || d.endsWith('.' + bareHost);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ── mwFetch ────────────────────────────────────────────────────────────────

type MwFetchInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

/**
 * Authenticated fetch against the MakerWorld API.
 * credentialBlob is JSON: { cookies: Array<{name, value, domain}> }
 */
export async function mwFetch(
  url: string,
  credentialBlob: string,
  init: MwFetchInit = {},
): Promise<Response> {
  const { cookies } = JSON.parse(credentialBlob) as { cookies: CookieEntry[] };
  const cookieHeader = buildCookieHeader(cookies);

  // MakerWorld sits behind Cloudflare; cf_clearance cookies are bound to a
  // (UA + IP) pair. Send a realistic browser UA so Cloudflare doesn't 403 us.
  // Caller-supplied init.headers can override any of these.
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://makerworld.com/',
    'Origin': 'https://makerworld.com',
    // Client hints + fetch metadata — some endpoints gate on presence.
    'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(init.headers ?? {}),
  };

  const response = await globalThis.fetch(url, { ...init, headers });

  if (response.ok) return response;

  const { status } = response;

  if (status === 401) throw new CredentialInvalidError();
  if (status === 403) throw new PermissionDeniedError();
  if (status === 404) throw new NotFoundError();

  if (status === 429) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseFloat(retryAfterHeader) : 60;
    const retryAfterMs = Math.round(retryAfterSec * 1000);
    throw new RateLimitedError(retryAfterMs);
  }

  if (status >= 500) throw new TransientError(status);

  // Unexpected non-2xx that doesn't match above — treat as transient
  throw new TransientError(status);
}
