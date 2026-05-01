/**
 * discovery.ts — V2-005d-c T_dc2
 *
 * UDP broadcast-based discovery for SDCP 3.0 printers (Elegoo Saturn 4+/Mars 5+).
 *
 * Sends an `M99999` probe to UDP `:3000` on the broadcast address. Printers
 * implementing SDCP reply with a JSON envelope describing themselves; legacy
 * ChituBox-firmware boards on the same port reply with an ASCII line which we
 * silently ignore here (T_dc6 handles the legacy ChituNetwork path).
 *
 * Discovery is best-effort: a socket error never throws, it just resolves the
 * promise with whatever was found before the error.
 */
import * as dgram from 'node:dgram';

import { logger } from '@/logger';

export interface SdcpPrinterInfo {
  /** Reply message UUID. */
  id: string;
  /** Printer's MainboardID — needed for MQTT topic routing later. */
  mainboardId: string;
  /** Printer's IP address. */
  mainboardIp: string;
  /** Operator-set printer name. */
  name: string;
  /** Manufacturer-reported printer model. */
  machineName: string;
  /** Brand string ("CBD" for ChiTu/Elegoo). */
  brandName: string;
  /** SDCP protocol version (e.g. "V3.0.0"). */
  protocolVersion: string;
  /** Firmware version string. */
  firmwareVersion: string;
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

const SDCP_BROADCAST_PORT = 3000;
const SDCP_PROBE = 'M99999';

interface SdcpReplyShape {
  Id: string;
  Data: {
    Name: string;
    MachineName: string;
    BrandName: string;
    MainboardIP: string;
    MainboardID: string;
    ProtocolVersion: string;
    FirmwareVersion: string;
  };
}

function parseSdcpReply(buf: Buffer): SdcpPrinterInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<SdcpReplyShape>;
  if (typeof obj.Id !== 'string') return null;
  const data = obj.Data;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.MainboardIP !== 'string') return null;
  if (typeof data.MainboardID !== 'string') return null;
  return {
    id: obj.Id,
    mainboardId: data.MainboardID,
    mainboardIp: data.MainboardIP,
    name: typeof data.Name === 'string' ? data.Name : '',
    machineName: typeof data.MachineName === 'string' ? data.MachineName : '',
    brandName: typeof data.BrandName === 'string' ? data.BrandName : '',
    protocolVersion: typeof data.ProtocolVersion === 'string' ? data.ProtocolVersion : '',
    firmwareVersion: typeof data.FirmwareVersion === 'string' ? data.FirmwareVersion : '',
  };
}

export async function discoverSdcpPrinters(opts?: {
  timeoutMs?: number;
  udpSocketFactory?: UdpSocketFactory;
  broadcastAddress?: string;
}): Promise<SdcpPrinterInfo[]> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const broadcastAddress = opts?.broadcastAddress ?? '255.255.255.255';
  const factory = opts?.udpSocketFactory ?? defaultUdpSocketFactory;

  const socket = factory();
  const found: SdcpPrinterInfo[] = [];
  const seen = new Set<string>();

  return new Promise<SdcpPrinterInfo[]>((resolve) => {
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
      const info = parseSdcpReply(msg);
      if (!info) return;
      if (seen.has(info.mainboardId)) return;
      seen.add(info.mainboardId);
      found.push(info);
    });

    socket.on('error', (err: Error) => {
      logger.warn({ err: err.message }, 'sdcp discovery socket error');
      finish();
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'sdcp discovery setBroadcast failed');
        finish();
        return;
      }
      socket.send(SDCP_PROBE, SDCP_BROADCAST_PORT, broadcastAddress, (err) => {
        if (err) {
          logger.warn({ err: err.message }, 'sdcp discovery probe send failed');
          // Do not finish — keep listening; some replies may already be queued.
        }
      });
    });

    setTimeout(finish, timeoutMs);
  });
}
