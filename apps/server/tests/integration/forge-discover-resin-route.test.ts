/**
 * Integration tests — GET /api/v1/forge/discover-resin — V2-005d-c T_dc9
 *
 * Discovery is a network-broadcast operation, so the actual UDP fan-out
 * is mocked via `setDiscoverResinPrintersFn` (mirrors the V2-005c T_c6
 * `setInstallerDeps` seam). Auth is shimmed via `mockAuthenticate`.
 *
 * Covers:
 *   1. 401 unauth (no actor).
 *   2. 200 for any authenticated user (no admin gate).
 *   3. Default timeoutMs = 5000 when no query param.
 *   4. ?timeoutMs=3000 flows through.
 *   5. ?timeoutMs=abc → 400.
 *   6. ?timeoutMs=999 below floor → 400; ?timeoutMs=99999 above ceiling → 400.
 *   7. logger.info fires post-discovery with sdcpCount + chituCount.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

import { setDiscoverResinPrintersFn } from '../../src/forge/dispatch/resin/route-helpers';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

const mockAuthenticate = vi.fn();
vi.mock('../../src/auth/request-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/request-auth')>();
  return {
    ...actual,
    authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  };
});

const mockLoggerInfo = vi.fn();
vi.mock('../../src/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

function actor(userId: string, role: 'admin' | 'user' = 'user') {
  return { id: userId, role, source: 'session' as const };
}

function makeGet(url: string): import('next/server').NextRequest {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server').NextRequest;
}

beforeAll(() => {
  // No DB needed — route does not touch persistence.
});

afterAll(() => {
  setDiscoverResinPrintersFn(null);
});

beforeEach(() => {
  mockAuthenticate.mockReset();
  mockLoggerInfo.mockReset();
  setDiscoverResinPrintersFn(null);
});

describe('GET /api/v1/forge/discover-resin', () => {
  it('401 without auth', async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');
    const res = await GET(makeGet('http://local/api/v1/forge/discover-resin'));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'unauthenticated' });
  });

  it('200 for any authenticated user (no admin gate)', async () => {
    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const fakeFn = vi.fn().mockResolvedValue({
      sdcp: [
        {
          id: 'a'.repeat(32),
          mainboardId: '0123456789abcdef',
          mainboardIp: '192.168.1.42',
          name: 'Saturn',
          machineName: 'Saturn 4 Ultra',
          brandName: 'CBD',
          protocolVersion: 'V3.0.0',
          firmwareVersion: 'V1.2.3',
        },
      ],
      chituNetwork: [{ name: 'Sonic', ip: '192.168.1.55' }],
    });
    setDiscoverResinPrintersFn(fakeFn);

    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');
    const res = await GET(makeGet('http://local/api/v1/forge/discover-resin'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sdcp).toHaveLength(1);
    expect(json.chituNetwork).toEqual([{ name: 'Sonic', ip: '192.168.1.55' }]);
  });

  it('uses default timeoutMs=5000 when no query param', async () => {
    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const fakeFn = vi.fn().mockResolvedValue({ sdcp: [], chituNetwork: [] });
    setDiscoverResinPrintersFn(fakeFn);

    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');
    const res = await GET(makeGet('http://local/api/v1/forge/discover-resin'));
    expect(res.status).toBe(200);
    expect(fakeFn).toHaveBeenCalledTimes(1);
    expect(fakeFn).toHaveBeenCalledWith({ timeoutMs: 5000 });
  });

  it('passes ?timeoutMs=3000 through', async () => {
    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const fakeFn = vi.fn().mockResolvedValue({ sdcp: [], chituNetwork: [] });
    setDiscoverResinPrintersFn(fakeFn);

    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');
    const res = await GET(makeGet('http://local/api/v1/forge/discover-resin?timeoutMs=3000'));
    expect(res.status).toBe(200);
    expect(fakeFn).toHaveBeenCalledWith({ timeoutMs: 3000 });
  });

  it('400 on non-numeric ?timeoutMs', async () => {
    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const fakeFn = vi.fn();
    setDiscoverResinPrintersFn(fakeFn);

    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');
    const res = await GET(makeGet('http://local/api/v1/forge/discover-resin?timeoutMs=abc'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid-query');
    expect(json.reason).toBe('timeoutMs-out-of-range');
    expect(fakeFn).not.toHaveBeenCalled();
  });

  it('400 on out-of-range ?timeoutMs (below min and above max)', async () => {
    const fakeFn = vi.fn();
    setDiscoverResinPrintersFn(fakeFn);

    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');

    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const lowRes = await GET(makeGet('http://local/api/v1/forge/discover-resin?timeoutMs=999'));
    expect(lowRes.status).toBe(400);

    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const highRes = await GET(makeGet('http://local/api/v1/forge/discover-resin?timeoutMs=99999'));
    expect(highRes.status).toBe(400);

    expect(fakeFn).not.toHaveBeenCalled();
  });

  it('logs info with sdcpCount + chituCount + durationMs after discovery', async () => {
    mockAuthenticate.mockResolvedValueOnce(actor('user-1', 'user'));
    const fakeFn = vi.fn().mockResolvedValue({
      sdcp: [
        {
          id: 'x'.repeat(32),
          mainboardId: 'abc',
          mainboardIp: '1.1.1.1',
          name: '',
          machineName: '',
          brandName: '',
          protocolVersion: '',
          firmwareVersion: '',
        },
        {
          id: 'y'.repeat(32),
          mainboardId: 'def',
          mainboardIp: '2.2.2.2',
          name: '',
          machineName: '',
          brandName: '',
          protocolVersion: '',
          firmwareVersion: '',
        },
      ],
      chituNetwork: [{ name: 'A', ip: '3.3.3.3' }],
    });
    setDiscoverResinPrintersFn(fakeFn);

    const { GET } = await import('../../src/app/api/v1/forge/discover-resin/route');
    const res = await GET(makeGet('http://local/api/v1/forge/discover-resin'));
    expect(res.status).toBe(200);
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const [meta, msg] = mockLoggerInfo.mock.calls[0]!;
    expect(meta).toMatchObject({ sdcpCount: 2, chituCount: 1 });
    expect(typeof (meta as { durationMs: unknown }).durationMs).toBe('number');
    expect(msg).toBe('forge resin discovery completed');
  });
});
