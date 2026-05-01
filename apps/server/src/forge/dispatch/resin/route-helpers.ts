/**
 * route-helpers.ts — V2-005d-c T_dc9
 *
 * Per-process injectable seam for the resin discovery HTTP route. Mirrors
 * the V2-005c T_c6 installer-deps pattern: the route always calls
 * `getDiscoverResinPrintersFn()`, which falls through to the real module
 * function unless tests have swapped it via `setDiscoverResinPrintersFn`.
 *
 * This indirection lives outside the `app/` tree because Next.js App
 * Router forbids non-route exports from `route.ts` files.
 */
import {
  discoverResinPrinters as realDiscoverResinPrinters,
  type DiscoverResinPrintersOptions,
  type ResinDiscoveryResult,
} from './discovery-router';

export type DiscoverResinPrintersFn = (
  opts?: DiscoverResinPrintersOptions,
) => Promise<ResinDiscoveryResult>;

let currentFn: DiscoverResinPrintersFn | null = null;

/** Returns the injected fn, falling back to the real discovery router. */
export function getDiscoverResinPrintersFn(): DiscoverResinPrintersFn {
  return currentFn ?? realDiscoverResinPrinters;
}

/**
 * Test seam — replace the discovery fn used by the route. Pass `null`
 * to restore the real production implementation.
 */
export function setDiscoverResinPrintersFn(fn: DiscoverResinPrintersFn | null): void {
  currentFn = fn;
}
