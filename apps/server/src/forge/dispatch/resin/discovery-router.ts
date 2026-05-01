/**
 * discovery-router.ts — V2-005d-c T_dc9
 *
 * Unified resin-printer discovery: runs the SDCP (T_dc2) and legacy
 * ChituNetwork (T_dc6) UDP probes concurrently and returns a merged
 * result. Both protocols share the same `M99999` broadcast wire on UDP
 * port 3000 — this module just kicks both off and lets each sub-module
 * silently skip the other's reply shape.
 *
 * Defensiveness: even though both sub-discoveries already obey a
 * never-throws contract, this router uses `Promise.allSettled` so one
 * arm crashing for any reason can't deny the caller the other arm's
 * results. Rejected promises degrade to empty arrays.
 */
import {
  discoverSdcpPrinters,
  type SdcpPrinterInfo,
  type UdpSocketFactory as SdcpUdpSocketFactory,
} from '../sdcp/discovery';
import {
  discoverChituNetworkPrinters,
  type ChituNetworkPrinterInfo,
  type UdpSocketFactory as ChituUdpSocketFactory,
} from '../chitu-network/discovery';

export interface ResinDiscoveryResult {
  sdcp: SdcpPrinterInfo[];
  chituNetwork: ChituNetworkPrinterInfo[];
}

export interface DiscoverResinPrintersOptions {
  /** Discovery window in ms; both arms share the same value. Default 5000. */
  timeoutMs?: number;
  /** Test seam — UDP socket factory for SDCP arm. */
  sdcpUdpSocketFactory?: SdcpUdpSocketFactory;
  /** Test seam — UDP socket factory for ChituNetwork arm. */
  chituUdpSocketFactory?: ChituUdpSocketFactory;
  /** Broadcast destination; both arms share it. Default 255.255.255.255. */
  broadcastAddress?: string;
}

/**
 * Run SDCP + ChituNetwork UDP probes concurrently and return both
 * result lists. Never throws — a sub-discovery rejection or empty
 * result simply yields an empty array on its side of the response.
 */
export async function discoverResinPrinters(
  opts?: DiscoverResinPrintersOptions,
): Promise<ResinDiscoveryResult> {
  const timeoutMs = opts?.timeoutMs;
  const broadcastAddress = opts?.broadcastAddress;

  const [sdcpSettled, chituSettled] = await Promise.allSettled([
    discoverSdcpPrinters({
      timeoutMs,
      broadcastAddress,
      udpSocketFactory: opts?.sdcpUdpSocketFactory,
    }),
    discoverChituNetworkPrinters({
      timeoutMs,
      broadcastAddress,
      udpSocketFactory: opts?.chituUdpSocketFactory,
    }),
  ]);

  return {
    sdcp: sdcpSettled.status === 'fulfilled' ? sdcpSettled.value : [],
    chituNetwork: chituSettled.status === 'fulfilled' ? chituSettled.value : [],
  };
}
