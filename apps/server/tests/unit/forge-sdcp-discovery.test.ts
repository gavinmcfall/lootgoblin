/**
 * Unit tests — V2-005d-c T_dc2
 *
 * UDP discovery module for SDCP 3.0 printers.
 *
 * Covers:
 *   1. Happy path — single valid SDCP reply yields one extracted printer.
 *   2. Happy path multi — three replies with distinct mainboardIds → 3 entries.
 *   3. Dedupe — two replies with same mainboardId → 1 entry.
 *   4. Malformed JSON skipped — no throw, empty result.
 *   5. ASCII (ChituNetwork legacy) reply skipped — no throw, empty result.
 *   6. Timeout — close() called and promise resolves after timeoutMs.
 *   7. Socket 'error' event does not throw — promise resolves with found-so-far.
 *   8. Broadcast send target — send invoked with M99999 + correct port + address.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverSdcpPrinters,
  type UdpSocketLike,
} from '../../src/forge/dispatch/sdcp/discovery';

interface MockSocket extends UdpSocketLike {
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
      // Defer to next tick so callers can attach listeners first if they want.
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

function validReply(overrides: Partial<{ Id: string; MainboardID: string; MainboardIP: string }> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      Id: overrides.Id ?? 'a'.repeat(32),
      Data: {
        Name: 'My Saturn',
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

afterEach(() => {
  vi.useRealTimers();
});

describe('discoverSdcpPrinters', () => {
  it('extracts a single printer from one valid reply', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    // Wait for bind callback to fire so listeners are attached.
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(validReply());
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      mainboardId: '0123456789abcdef',
      mainboardIp: '192.168.1.42',
      name: 'My Saturn',
      machineName: 'Saturn 4 Ultra',
      brandName: 'CBD',
      protocolVersion: 'V3.0.0',
      firmwareVersion: 'V1.2.3',
    });
    expect(sock.closed).toBe(true);
  });

  it('returns three entries for three distinct mainboardIds', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(validReply({ MainboardID: 'aaaaaaaaaaaaaaaa', Id: 'a'.repeat(32) }));
    sock.fireMessage(validReply({ MainboardID: 'bbbbbbbbbbbbbbbb', Id: 'b'.repeat(32) }));
    sock.fireMessage(validReply({ MainboardID: 'cccccccccccccccc', Id: 'c'.repeat(32) }));
    const out = await promise;
    expect(out.map((p) => p.mainboardId).sort()).toEqual([
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
      'cccccccccccccccc',
    ]);
  });

  it('dedupes by mainboardId', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(validReply({ MainboardID: 'dupedupedupedupe' }));
    sock.fireMessage(validReply({ MainboardID: 'dupedupedupedupe' }));
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(out[0]?.mainboardId).toBe('dupedupedupedupe');
  });

  it('silently skips malformed JSON', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('not json'));
    const out = await promise;
    expect(out).toEqual([]);
  });

  it('silently skips ChituNetwork ASCII replies', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('ok. NAME:Test IP:192.168.1.10'));
    const out = await promise;
    expect(out).toEqual([]);
  });

  it('closes the socket and resolves after timeoutMs', async () => {
    vi.useFakeTimers();
    const sock = makeMockSocket();
    // Replace bind so it fires synchronously under fake timers.
    sock.bind = (cb: () => void) => {
      cb();
    };
    const promise = discoverSdcpPrinters({
      timeoutMs: 5000,
      udpSocketFactory: () => sock,
    });
    expect(sock.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    const out = await promise;
    expect(out).toEqual([]);
    expect(sock.closed).toBe(true);
  });

  it('does not throw when socket emits an error event', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 5000,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    // Fire one valid reply, then an error — promise should resolve with that one entry.
    sock.fireMessage(validReply({ MainboardID: 'errorerrorerror1' }));
    sock.fireError(new Error('EACCES'));
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(out[0]?.mainboardId).toBe('errorerrorerror1');
    expect(sock.closed).toBe(true);
  });

  it('sends M99999 to the broadcast address on port 3000', async () => {
    const sock = makeMockSocket();
    const promise = discoverSdcpPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
      broadcastAddress: '10.0.0.255',
    });
    await promise;
    expect(sock.sentMessages).toHaveLength(1);
    expect(sock.sentMessages[0]).toEqual({
      msg: 'M99999',
      port: 3000,
      address: '10.0.0.255',
    });
    expect(sock.broadcastSet).toBe(true);
  });
});
