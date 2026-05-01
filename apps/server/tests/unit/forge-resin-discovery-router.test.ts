/**
 * Unit tests — V2-005d-c T_dc9
 *
 * Unified resin discovery router that fans out to both SDCP (T_dc2) and
 * legacy ChituNetwork (T_dc6) UDP probes. We mock both UDP socket
 * factories and drive their `message`/`error` events directly.
 *
 * Covers:
 *   1. Both protocols return results — merged shape with both arms populated.
 *   2. One arm times out, the other returns — merged shape with that arm empty.
 *   3. Both arms error — promise resolves to empty arrays (never throws).
 *   4. Cross-contamination — JSON to ChituNetwork's socket and ASCII to SDCP's
 *      socket are silently dropped; neither arm absorbs the other's reply.
 *   5. Custom broadcastAddress + timeoutMs flow into both sub-discoveries.
 *   6. Promise.allSettled defensiveness — if SDCP rejects, ChituNetwork still
 *      surfaces (and vice versa).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverResinPrinters,
  type ResinDiscoveryResult,
} from '../../src/forge/dispatch/resin/discovery-router';
import type { UdpSocketLike as SdcpUdpSocketLike } from '../../src/forge/dispatch/sdcp/discovery';
import type { UdpSocketLike as ChituUdpSocketLike } from '../../src/forge/dispatch/chitu-network/discovery';

interface MockSocket extends SdcpUdpSocketLike, ChituUdpSocketLike {
  fireMessage(buf: Buffer): void;
  fireError(err: Error): void;
  closed: boolean;
  sentMessages: Array<{ msg: string | Buffer; port: number; address: string }>;
  broadcastSet: boolean;
}

function makeMockSocket(): MockSocket {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  let bindCb: (() => void) | null = null;
  const sock: MockSocket = {
    closed: false,
    sentMessages: [],
    broadcastSet: false,
    bind(cb: () => void) {
      bindCb = cb;
      setImmediate(() => {
        if (bindCb) bindCb();
      });
    },
    setBroadcast(enabled: boolean) {
      sock.broadcastSet = enabled;
    },
    send(msg, port, address, cb) {
      sock.sentMessages.push({ msg, port, address });
      if (cb) cb();
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
    },
    close() {
      sock.closed = true;
    },
    fireMessage(buf) {
      for (const l of listeners['message'] ?? []) l(buf);
    },
    fireError(err) {
      for (const l of listeners['error'] ?? []) l(err);
    },
  };
  return sock;
}

function validSdcpReply(overrides: Partial<{ Id: string; MainboardID: string; MainboardIP: string }> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      Id: overrides.Id ?? 'a'.repeat(32),
      Data: {
        Name: 'Saturn 4 Ultra',
        MachineName: 'Saturn 4 Ultra',
        BrandName: 'CBD',
        MainboardIP: overrides.MainboardIP ?? '192.168.1.42',
        MainboardID: overrides.MainboardID ?? '0123456789abcdef',
        ProtocolVersion: 'V3.0.0',
        FirmwareVersion: 'V1.2.3',
      },
    }),
  );
}

function validChituReply(name = 'Sonic Mighty', ip = '192.168.1.55'): Buffer {
  return Buffer.from(`ok. NAME:${name} IP:${ip}`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('discoverResinPrinters', () => {
  it('returns merged results when both protocols reply', async () => {
    const sdcpSock = makeMockSocket();
    const chituSock = makeMockSocket();
    const promise = discoverResinPrinters({
      timeoutMs: 50,
      sdcpUdpSocketFactory: () => sdcpSock,
      chituUdpSocketFactory: () => chituSock,
    });
    await new Promise((r) => setImmediate(r));
    sdcpSock.fireMessage(validSdcpReply());
    chituSock.fireMessage(validChituReply());
    const out = await promise;
    expect(out.sdcp).toHaveLength(1);
    expect(out.sdcp[0]).toMatchObject({
      mainboardId: '0123456789abcdef',
      mainboardIp: '192.168.1.42',
    });
    expect(out.chituNetwork).toHaveLength(1);
    expect(out.chituNetwork[0]).toEqual({ name: 'Sonic Mighty', ip: '192.168.1.55' });
  });

  it('returns one arm even when the other times out empty', async () => {
    const sdcpSock = makeMockSocket();
    const chituSock = makeMockSocket();
    const promise = discoverResinPrinters({
      timeoutMs: 50,
      sdcpUdpSocketFactory: () => sdcpSock,
      chituUdpSocketFactory: () => chituSock,
    });
    await new Promise((r) => setImmediate(r));
    // Only ChituNetwork replies; SDCP gets nothing and times out.
    chituSock.fireMessage(validChituReply('Phrozen', '10.1.1.5'));
    const out = await promise;
    expect(out.sdcp).toEqual([]);
    expect(out.chituNetwork).toEqual([{ name: 'Phrozen', ip: '10.1.1.5' }]);
  });

  it('resolves with empty arrays when both arms error', async () => {
    const sdcpSock = makeMockSocket();
    const chituSock = makeMockSocket();
    const promise = discoverResinPrinters({
      timeoutMs: 5000,
      sdcpUdpSocketFactory: () => sdcpSock,
      chituUdpSocketFactory: () => chituSock,
    });
    await new Promise((r) => setImmediate(r));
    sdcpSock.fireError(new Error('EACCES'));
    chituSock.fireError(new Error('EACCES'));
    const out = await promise;
    expect(out).toEqual<ResinDiscoveryResult>({ sdcp: [], chituNetwork: [] });
    expect(sdcpSock.closed).toBe(true);
    expect(chituSock.closed).toBe(true);
  });

  it('does not cross-route reply shapes between arms', async () => {
    const sdcpSock = makeMockSocket();
    const chituSock = makeMockSocket();
    const promise = discoverResinPrinters({
      timeoutMs: 50,
      sdcpUdpSocketFactory: () => sdcpSock,
      chituUdpSocketFactory: () => chituSock,
    });
    await new Promise((r) => setImmediate(r));
    // Wrong-shape replies on each socket — both arms must drop them.
    sdcpSock.fireMessage(validChituReply('Wrong', '1.1.1.1'));
    chituSock.fireMessage(validSdcpReply({ MainboardID: 'wrongarm00000000' }));
    const out = await promise;
    expect(out.sdcp).toEqual([]);
    expect(out.chituNetwork).toEqual([]);
  });

  it('passes broadcastAddress + timeoutMs through to both arms', async () => {
    const sdcpSock = makeMockSocket();
    const chituSock = makeMockSocket();
    const promise = discoverResinPrinters({
      timeoutMs: 75,
      broadcastAddress: '10.0.0.255',
      sdcpUdpSocketFactory: () => sdcpSock,
      chituUdpSocketFactory: () => chituSock,
    });
    await promise;
    expect(sdcpSock.sentMessages).toEqual([
      { msg: 'M99999', port: 3000, address: '10.0.0.255' },
    ]);
    expect(chituSock.sentMessages).toEqual([
      { msg: 'M99999', port: 3000, address: '10.0.0.255' },
    ]);
    expect(sdcpSock.broadcastSet).toBe(true);
    expect(chituSock.broadcastSet).toBe(true);
  });

  it('Promise.allSettled defensiveness — one rejection still yields the other arm', async () => {
    // Force the SDCP socket factory itself to throw (synchronous reject path).
    const chituSock = makeMockSocket();
    const promise = discoverResinPrinters({
      timeoutMs: 50,
      sdcpUdpSocketFactory: () => {
        throw new Error('synchronous factory failure');
      },
      chituUdpSocketFactory: () => chituSock,
    });
    await new Promise((r) => setImmediate(r));
    chituSock.fireMessage(validChituReply('Mars', '10.0.0.7'));
    const out = await promise;
    expect(out.sdcp).toEqual([]);
    expect(out.chituNetwork).toEqual([{ name: 'Mars', ip: '10.0.0.7' }]);
  });
});
