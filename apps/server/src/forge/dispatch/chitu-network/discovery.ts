/**
 * discovery.ts — V2-005d-c T_dc6
 *
 * UDP broadcast-based discovery for legacy ChituBox-network firmware printers
 * (Phrozen Sonic, Uniformation GKtwo, legacy Elegoo Saturn 2/3, etc.).
 *
 * Same broadcast wire as SDCP T_dc2: send `M99999` to UDP `:3000` on the
 * broadcast address. Where SDCP printers reply with a JSON envelope, legacy
 * ChituBox firmware replies with a single ASCII line of the form:
 *
 *   ok. NAME:<operator-set name> IP:<dotted-quad>
 *
 * When both protocols coexist on a network we end up seeing both reply
 * shapes; this module silently skips anything that doesn't match the ASCII
 * pattern (so SDCP's JSON replies are correctly ignored here), mirroring how
 * the SDCP discovery module silently skips ASCII replies.
 *
 * Discovery is best-effort: a socket error never throws, it just resolves
 * the promise with whatever was found before the error.
 */
import * as dgram from 'node:dgram';

import { logger } from '@/logger';

export interface ChituNetworkPrinterInfo {
  /** Operator-set printer name reported by the printer. */
  name: string;
  /** Printer's IP address. */
  ip: string;
}

export interface UdpSocketLike {
  bind(callback: () => void): void;
  setBroadcast(enabled: boolean): void;
  send(msg: string | Buffer, port: number, address: string, callback?: (err?: Error) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;
  close(): void;
}

export interface UdpSocketFactory {
  (): UdpSocketLike;
}

const defaultUdpSocketFactory: UdpSocketFactory = () => dgram.createSocket('udp4') as unknown as UdpSocketLike;

const CHITU_BROADCAST_PORT = 3000;
const CHITU_PROBE = 'M99999';

// Anchored on `ok.` prefix. NAME may contain spaces; IP is non-whitespace
// (validated downstream — a stray reply with garbage in IP simply won't match
// any real printer state when it's later used for HTTP requests).
const CHITU_REPLY_RE = /^ok\.\s+NAME:(.+?)\s+IP:(\S+)\s*$/;

function parseChituNetworkReply(buf: Buffer): ChituNetworkPrinterInfo | null {
  const text = buf.toString('utf8').trim();
  const m = CHITU_REPLY_RE.exec(text);
  if (!m) return null;
  const name = m[1]?.trim();
  const ip = m[2]?.trim();
  if (!name || !ip) return null;
  return { name, ip };
}

export async function discoverChituNetworkPrinters(opts?: {
  timeoutMs?: number;
  udpSocketFactory?: UdpSocketFactory;
  broadcastAddress?: string;
}): Promise<ChituNetworkPrinterInfo[]> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const broadcastAddress = opts?.broadcastAddress ?? '255.255.255.255';
  const factory = opts?.udpSocketFactory ?? defaultUdpSocketFactory;

  const socket = factory();
  const found: ChituNetworkPrinterInfo[] = [];
  const seen = new Set<string>();

  return new Promise<ChituNetworkPrinterInfo[]>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore — socket may already be closed
      }
      resolve(found);
    };

    socket.on('message', (msg: Buffer) => {
      const info = parseChituNetworkReply(msg);
      if (!info) return;
      if (seen.has(info.ip)) return;
      seen.add(info.ip);
      found.push(info);
    });

    socket.on('error', (err: Error) => {
      logger.warn({ err: err.message }, 'chitu-network discovery socket error');
      finish();
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'chitu-network discovery setBroadcast failed');
        finish();
        return;
      }
      socket.send(CHITU_PROBE, CHITU_BROADCAST_PORT, broadcastAddress, (err) => {
        if (err) {
          logger.warn({ err: err.message }, 'chitu-network discovery probe send failed');
          // Do not finish — keep listening; some replies may already be queued.
        }
      });
    });

    setTimeout(finish, timeoutMs);
  });
}
