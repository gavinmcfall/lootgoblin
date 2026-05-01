/**
 * _ws-client.ts — V2-005f-T_dcf5
 *
 * Shared WebSocket-client surface used by status subscribers (Moonraker
 * JSON-RPC, OctoPrint SockJS, and future SDCP/Bambu transports). Mirrors
 * the relevant subset of the `ws` package and lets tests inject a fake
 * factory.
 *
 * Originally lived inside `moonraker.ts`; lifted here in T_dcf5 when the
 * second WebSocket-based subscriber (OctoPrint SockJS) needed the same
 * plumbing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal WebSocket-client surface used by status subscribers. Mirrors
 * the relevant subset of the `ws` package and lets tests inject a fake.
 */
export interface WsClientLike {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: (code?: number, reason?: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  send(data: string, callback?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface WsFactory {
  (url: string, options?: { headers?: Record<string, string> }): WsClientLike;
}

/**
 * Default `ws` factory — lazy-loads the `ws` runtime dependency so tests
 * don't have to pay for it. Resolves the constructor across CommonJS /
 * ESM-default / named-export shapes.
 */
export function defaultWsFactory(
  url: string,
  options?: { headers?: Record<string, string> },
): WsClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wsMod = require('ws') as
    | (new (url: string, opts?: { headers?: Record<string, string> }) => WsClientLike)
    | {
        default?: new (url: string, opts?: { headers?: Record<string, string> }) => WsClientLike;
        WebSocket?: new (
          url: string,
          opts?: { headers?: Record<string, string> },
        ) => WsClientLike;
      };
  const Ctor =
    typeof wsMod === 'function'
      ? wsMod
      : ((wsMod as { WebSocket?: any }).WebSocket ??
        (wsMod as { default?: any }).default);
  if (typeof Ctor !== 'function') {
    throw new Error('status-subscriber: unable to resolve ws constructor');
  }
  return new (Ctor as new (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => WsClientLike)(url, { headers: options?.headers });
}
