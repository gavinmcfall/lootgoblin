/**
 * Unit tests — SDCP WebSocket commander — V2-005d-c T_dc4
 *
 * Covers all 8 cases from the task spec. We inject a mock MqttFactory so no
 * real WebSocket connection is opened. The mock exposes manual triggers for
 * `'connect'`, `'error'`, and the publish callback so each scenario can drive
 * the timing precisely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startSdcpPrint,
  type MqttClientLike,
  type MqttFactory,
} from '@/forge/dispatch/sdcp/commander';

interface MockClient extends MqttClientLike {
  publish: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  /** Trigger the registered 'connect' handler. */
  fireConnect(): void;
  /** Trigger the registered 'error' handler. */
  fireError(err: Error): void;
  /** Inspect captured publish call. */
  capturedPublishCb?: (err?: Error) => void;
}

interface FactoryShape {
  factory: MqttFactory;
  client: MockClient;
  factoryCalls: Array<{ url: string; opts: { rejectUnauthorized: boolean } }>;
}

function makeFactory(opts?: {
  publishError?: Error;
  autoConnect?: boolean;
  errorOnConnect?: Error;
}): FactoryShape {
  const factoryCalls: FactoryShape['factoryCalls'] = [];
  let connectListener: (() => void) | null = null;
  let errorListener: ((err: Error) => void) | null = null;

  const client: MockClient = {
    publish: vi.fn(
      (
        _topic: string,
        _payload: string,
        _o: object,
        cb: (err?: Error) => void,
      ) => {
        client.capturedPublishCb = cb;
        if (opts?.publishError) {
          cb(opts.publishError);
        } else {
          cb(undefined);
        }
      },
    ),
    end: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') errorListener = listener as (err: Error) => void;
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'connect') {
        connectListener = listener as () => void;
        if (opts?.autoConnect) queueMicrotask(() => connectListener?.());
      }
    }),
    fireConnect() {
      if (connectListener) connectListener();
    },
    fireError(err: Error) {
      if (errorListener) errorListener(err);
    },
  };

  const factory: MqttFactory = (url, factoryOpts) => {
    factoryCalls.push({ url, opts: factoryOpts });
    if (opts?.errorOnConnect) {
      queueMicrotask(() => client.fireError(opts.errorOnConnect as Error));
    }
    return client;
  };

  return { factory, client, factoryCalls };
}

const MAINBOARD = 'MB-DEADBEEF-001';
const FILENAME = 'model.ctb';
const PRINTER_IP = '192.168.1.77';

afterEach(() => {
  vi.useRealTimers();
});

describe('startSdcpPrint', () => {
  it('1. happy path — publishes Cmd 128 to sdcp/request/<MainboardID>', async () => {
    const f = makeFactory({ autoConnect: true });

    const result = await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
    });

    expect(result).toEqual({ kind: 'success' });
    expect(f.client.publish).toHaveBeenCalledOnce();
    const [topic, payloadStr] = f.client.publish.mock.calls[0];
    expect(topic).toBe(`sdcp/request/${MAINBOARD}`);
    const payload = JSON.parse(payloadStr as string);
    expect(payload.Data.Cmd).toBe(128);
    expect(payload.Data.Data.Filename).toBe(FILENAME);
    expect(payload.Data.MainboardID).toBe(MAINBOARD);
    expect(payload.Topic).toBe(`sdcp/request/${MAINBOARD}`);
    expect(payload.Data.From).toBe(0);
    expect(payload.Data.Data.StartLayer).toBe(0);
  });

  it('2. TimeStamp is recent (within ±10 seconds)', async () => {
    const f = makeFactory({ autoConnect: true });
    const beforeUnix = Math.floor(Date.now() / 1000);

    await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
    });

    const afterUnix = Math.floor(Date.now() / 1000);
    const payloadStr = f.client.publish.mock.calls[0][1] as string;
    const payload = JSON.parse(payloadStr);
    expect(payload.Data.TimeStamp).toBeGreaterThanOrEqual(beforeUnix - 10);
    expect(payload.Data.TimeStamp).toBeLessThanOrEqual(afterUnix + 10);
  });

  it('3. connect timeout — no connect event within timeoutMs', async () => {
    vi.useFakeTimers();
    const f = makeFactory(); // never auto-connects

    const promise = startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('timeout');
    }
    expect(f.client.end).toHaveBeenCalled();
  });

  it('4. ECONNREFUSED → unreachable', async () => {
    const f = makeFactory({ errorOnConnect: new Error('connect ECONNREFUSED 192.168.1.77:3030') });

    const result = await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
      timeoutMs: 5_000,
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('unreachable');
      expect(result.details).toContain('ECONNREFUSED');
    }
  });

  it('5. publish error → unknown', async () => {
    const f = makeFactory({
      autoConnect: true,
      publishError: new Error('something blew up mid-send'),
    });

    const result = await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.reason).toBe('unknown');
      expect(result.details).toContain('blew up');
    }
  });

  it('6. client.end() always called — success path', async () => {
    const f = makeFactory({ autoConnect: true });
    await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
    });
    expect(f.client.end).toHaveBeenCalled();
  });

  it('6b. client.end() always called — failure path', async () => {
    const f = makeFactory({ errorOnConnect: new Error('connect ENOTFOUND foo') });
    await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
      timeoutMs: 5_000,
    });
    expect(f.client.end).toHaveBeenCalled();
  });

  it('7. startLayer parameter is forwarded into Data.Data.StartLayer', async () => {
    const f = makeFactory({ autoConnect: true });

    await startSdcpPrint({
      printerIp: PRINTER_IP,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      startLayer: 10,
      mqttFactory: f.factory,
    });

    const payloadStr = f.client.publish.mock.calls[0][1] as string;
    const payload = JSON.parse(payloadStr);
    expect(payload.Data.Data.StartLayer).toBe(10);
  });

  it('8. custom port — URL is ws://<ip>:<port>/websocket', async () => {
    const f = makeFactory({ autoConnect: true });

    await startSdcpPrint({
      printerIp: PRINTER_IP,
      port: 8080,
      mainboardId: MAINBOARD,
      filename: FILENAME,
      mqttFactory: f.factory,
    });

    expect(f.factoryCalls).toHaveLength(1);
    expect(f.factoryCalls[0].url).toBe(`ws://${PRINTER_IP}:8080/websocket`);
    expect(f.factoryCalls[0].opts.rejectUnauthorized).toBe(false);
  });
});
