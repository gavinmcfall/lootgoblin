// Single row in the Power table.
// Canvas ref: FleetPowerRow (page-fleet.jsx line 187–243).

import Link from 'next/link';
import { MetaBadge } from '@/components/shell/atoms';
import { PrinterDot } from './PrinterDot';
import { printerKindLabel, printerStateLabel, STATE_TONE, type PrinterState } from './forge-labels';

export interface FleetPowerRowProps {
  id: string;
  name: string;
  kind: string;
  state: PrinterState;
  protocol: string;
  /** Active dispatch job loot name, if printing. */
  jobName?: string;
  /** Progress 0–1, if printing. */
  progress?: number;
  /** ETA string e.g. '3h 12m', if printing. */
  eta?: string;
  disabled?: boolean;
}

export function FleetPowerRow({ id, name, kind, state, protocol, jobName, progress, eta, disabled }: FleetPowerRowProps) {
  const tone = STATE_TONE[state];
  const isOffline = state === 'offline' || state === 'disabled';

  return (
    <tr className={`border-b border-hairline ${isOffline ? 'opacity-55' : ''}`}>
      {/* State dot */}
      <td className="px-[10px] py-[9px] w-5">
        <PrinterDot state={state} />
      </td>

      {/* Name + protocol */}
      <td className="px-[10px] py-[9px]">
        <div className="font-sans text-[12.5px] font-semibold text-fg">{name}</div>
        <div className="font-mono text-[10px] text-fg-faint mt-px">{protocol}</div>
      </td>

      {/* Kind */}
      <td className="px-[10px] py-[9px] font-mono text-[10.5px] text-fg-muted uppercase tracking-[0.6px]">
        {printerKindLabel(kind)}
      </td>

      {/* Via (courier placeholder) */}
      <td className="px-[10px] py-[9px] font-mono text-[10.5px] text-fg-muted">
        {/* TODO: Courier pillar (V3+) will show Courier name + state here */}
        <span>LAN direct</span>
      </td>

      {/* Status badge */}
      <td className="px-[10px] py-[9px]">
        <MetaBadge tone={tone}>
          {disabled ? <span className="italic">{printerStateLabel(state)}</span> : printerStateLabel(state)}
        </MetaBadge>
      </td>

      {/* Progress */}
      <td className="px-[10px] py-[9px] w-[130px]">
        {progress != null ? (
          <div>
            <div className="h-[3px] rounded-sm bg-surface-2 overflow-hidden">
              <div className="h-full bg-running" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="flex justify-between mt-0.5 font-mono text-[9.5px] text-fg-faint">
              <span>{Math.round(progress * 100)}%</span>
              {eta && <span>{eta}</span>}
            </div>
          </div>
        ) : (
          <span className="font-mono text-[10px] text-fg-faint">—</span>
        )}
      </td>

      {/* Job name */}
      <td className="px-[10px] py-[9px] font-sans text-[11.5px] text-fg-muted max-w-[180px] truncate">
        {jobName ?? '—'}
      </td>

      {/* Actions */}
      <td className="px-[10px] py-[9px]">
        <Link
          href={`/forge/printers/${id}`}
          className="font-mono text-[10px] uppercase tracking-[0.6px] px-[9px] py-1 rounded bg-transparent text-fg-muted border border-hairline cursor-pointer hover:text-fg inline-block"
        >
          details
        </Link>
      </td>
    </tr>
  );
}
