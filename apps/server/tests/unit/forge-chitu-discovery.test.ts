/**
 * Unit tests — V2-005d-c T_dc6
 *
 * UDP discovery module for legacy ChituBox-network firmware printers.
 *
 * Covers:
 *   1. Happy path — single ASCII reply yields one printer.
 *   2. Happy path multi — two replies with distinct IPs → 2 entries.
 *   3. Dedupe — two replies with same IP → 1 entry.
 *   4. SDCP JSON reply silently skipped — empty result.
 *   5. Garbage reply skipped — empty result.
 *   6. Timeout — close() called and promise resolves after timeoutMs.
 *   7. Socket 'error' event does not throw — promise resolves with found-so-far.
 *   8. Broadcast send target — send invoked with M99999 + correct port + address.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverChituNetworkPrinters,
  type UdpSocketLike,
} from '../../src/forge/dispatch/chitu-network/discovery';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('discoverChituNetworkPrinters', () => {
  it('extracts a single printer from one valid ASCII reply', async () => {
    const sock = makeMockSocket();
    const promise = discoverChituNetworkPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('ok. NAME:Phrozen Mighty 8K IP:192.168.1.42'));
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: 'Phrozen Mighty 8K',
      ip: '192.168.1.42',
    });
    expect(sock.closed).toBe(true);
  });

  it('returns two entries for two distinct IPs', async () => {
    const sock = makeMockSocket();
    const promise = discoverChituNetworkPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('ok. NAME:Sonic Mini IP:192.168.1.10'));
    sock.fireMessage(Buffer.from('ok. NAME:GKtwo IP:192.168.1.11'));
    const out = await promise;
    expect(out.map((p) => p.ip).sort()).toEqual(['192.168.1.10', '192.168.1.11']);
  });

  it('dedupes by ip', async () => {
    const sock = makeMockSocket();
    const promise = discoverChituNetworkPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('ok. NAME:First IP:192.168.1.50'));
    sock.fireMessage(Buffer.from('ok. NAME:Second IP:192.168.1.50'));
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(out[0]?.ip).toBe('192.168.1.50');
  });

  it('silently skips SDCP JSON replies', async () => {
    const sock = makeMockSocket();
    const promise = discoverChituNetworkPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(
      Buffer.from(
        JSON.stringify({
          Id: 'a'.repeat(32),
          Data: {
            Name: 'Saturn',
            MainboardIP: '192.168.1.99',
            MainboardID: '0123456789abcdef',
          },
        }),
      ),
    );
    const out = await promise;
    expect(out).toEqual([]);
  });

  it('silently skips garbage replies', async () => {
    const sock = makeMockSocket();
    const promise = discoverChituNetworkPrinters({
      timeoutMs: 50,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('garbage'));
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
    const promise = discoverChituNetworkPrinters({
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
    const promise = discoverChituNetworkPrinters({
      timeoutMs: 5000,
      udpSocketFactory: () => sock,
    });
    await new Promise((r) => setImmediate(r));
    sock.fireMessage(Buffer.from('ok. NAME:Sonic IP:192.168.1.77'));
    sock.fireError(new Error('EACCES'));
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(out[0]?.ip).toBe('192.168.1.77');
    expect(sock.closed).toBe(true);
  });

  it('sends M99999 to the broadcast address on port 3000', async () => {
    const sock = makeMockSocket();
    const promise = discoverChituNetworkPrinters({
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
