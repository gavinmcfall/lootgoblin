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
 * Filter a cookie jar by domain suffix and join as a single Cookie header value.
 */
export function buildCookieHeader(
  jar: CookieEntry[],
  domainSuffix = '.makerworld.com',
): string {
  return jar
    .filter(c => c.domain === domainSuffix || c.domain.endsWith(domainSuffix))
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

  const headers: Record<string, string> = {
    'User-Agent': 'lootgoblin/1.0 (+https://github.com/gavinmcfall/lootgoblin)',
    'Referer': 'https://makerworld.com/',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(init.headers ?? {}),
  };

  const response = await globalThis.fetch(url, { ...init, headers });

  if (response.ok) {
    return response;
  }

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
