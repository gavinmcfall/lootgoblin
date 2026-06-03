import type { Tone } from '@/components/shell/atoms';

/**
 * Map a ledger event kind to a MetaBadge tone, heuristically.
 *
 * Event kinds follow `namespace.verb-phrase`; we don't know the full set, so
 * we match on the verb. Conservative — anything unrecognised → neutral.
 */
export function toneForKind(kind: string): Tone {
  const k = kind.toLowerCase();
  const verb = k.includes('.') ? k.slice(k.lastIndexOf('.') + 1) : k;

  if (
    verb.endsWith('failed') ||
    verb.endsWith('rejected') ||
    verb.endsWith('error') ||
    verb.endsWith('errored')
  ) {
    return 'danger';
  }
  if (verb.endsWith('dismissed') || verb.endsWith('skipped') || verb.endsWith('cancelled') || verb.endsWith('canceled')) {
    return 'neutral';
  }
  if (verb === 'running' || verb.endsWith('started') || verb.endsWith('queued') || verb.endsWith('claimed')) {
    return 'running';
  }
  if (
    verb.endsWith('completed') ||
    verb.endsWith('applied') ||
    verb.endsWith('created') ||
    verb.endsWith('succeeded') ||
    verb.endsWith('placed') ||
    verb.endsWith('ingested')
  ) {
    return 'success';
  }
  return 'neutral';
}
