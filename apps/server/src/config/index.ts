/**
 * Config resolver singleton — V2-001-T3
 *
 * Import the resolver instance from here so other modules get the same
 * already-resolved instance without triggering a second resolution pass.
 *
 * Usage:
 *   import { configResolver } from '../config/index.js';
 *   const secret = configResolver.get('BETTER_AUTH_SECRET');
 *
 * The singleton is populated by instrumentation.ts during Next.js startup
 * BEFORE any request handler or worker runs. Calling .get() before that
 * will throw a ConfigurationError.
 */

export { ConfigResolver, ConfigurationError } from './resolver.js';
export type { ResolvedConfig, ProvenanceEntry, ConfigSource } from './types.js';
export {
  REQUIRED_BOOT_KEYS,
  WIZARD_DEFERRABLE_KEYS,
  CONFIG_DEFAULTS,
} from './types.js';

import { ConfigResolver } from './resolver.js';

/**
 * The application-wide singleton resolver.
 * resolve() is called once in instrumentation.ts during startup.
 */
export const configResolver = new ConfigResolver();
