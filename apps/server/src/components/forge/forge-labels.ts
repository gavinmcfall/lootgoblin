// Shared label helpers for Forge fleet UI.
// Single source of truth across FleetCard, FleetPowerRow, and fleet pages.

import { type Tone } from '@/components/shell/atoms';

/** Human-readable printer kind label. */
export function printerKindLabel(kind: string): string {
  switch (kind) {
    case 'fdm_klipper':      return 'FDM · Klipper';
    case 'fdm_bambu_lan':    return 'FDM · Bambu LAN';
    case 'fdm_octoprint':    return 'FDM · OctoPrint';
    case 'resin_sdcp':       return 'Resin · SDCP';
    case 'resin_chitu':      return 'Resin · ChituNet';
    // Bambu per-model kinds
    case 'bambu_h2d':        return 'Bambu H2D';
    case 'bambu_h2d_pro':    return 'Bambu H2D Pro';
    case 'bambu_h2c':        return 'Bambu H2C';
    case 'bambu_h2s':        return 'Bambu H2S';
    case 'bambu_x2d':        return 'Bambu X2D';
    case 'bambu_p2s':        return 'Bambu P2S';
    case 'bambu_p1s':        return 'Bambu P1S';
    case 'bambu_p1p':        return 'Bambu P1P';
    case 'bambu_a1':         return 'Bambu A1';
    case 'bambu_a1_mini':    return 'Bambu A1 Mini';
    case 'bambu_x1c':        return 'Bambu X1C';
    case 'bambu_x1e':        return 'Bambu X1E';
    default:                 return kind;
  }
}

/** Human-readable printer state label. */
export function printerStateLabel(state: PrinterState): string {
  switch (state) {
    case 'running':  return 'Printing';
    case 'queue':    return 'Queued';
    case 'idle':     return 'Ready';
    case 'disabled': return 'Disabled';
    case 'error':    return 'Error';
    case 'offline':  return 'Offline';
    case 'unknown':  return 'Unknown';
  }
}

/** Derived per-printer state from API data. */
export type PrinterState =
  | 'running'
  | 'queue'
  | 'idle'
  | 'disabled'
  | 'error'
  | 'offline'
  | 'unknown';

/**
 * Broad kind family used for the SVG glyph — collapses all protocol variants
 * down to 'fdm' or 'resin'.
 */
export function printerGlyphKind(kind: string): 'fdm' | 'resin' {
  if (kind.startsWith('resin')) return 'resin';
  return 'fdm';
}

/**
 * Tone for the printer state MetaBadge. Single source of truth — both
 * FleetCard and FleetPowerRow import this rather than maintaining their own
 * copies (prevents drift).
 *
 * Note: 'disabled' uses 'neutral' tone; visual distinction comes from
 * row-level opacity-55 + italic suffix at the consumer, not the badge tone.
 */
export const STATE_TONE: Record<PrinterState, Tone> = {
  running:  'running',
  queue:    'accent',
  idle:     'neutral',
  disabled: 'neutral',
  error:    'danger',
  offline:  'neutral',
  unknown:  'neutral',
};

/**
 * Human-readable agent label (connection route).
 *
 * TODO(courier-v3): wire agentLabel into FleetPowerRow Via cell when
 * Courier pillar lands — currently hardcoded to 'LAN direct'.
 */
export function agentLabel(kind: string): string {
  switch (kind) {
    case 'central_worker': return 'Local agent';
    case 'courier':        return 'Courier';
    default:               return kind;
  }
}
