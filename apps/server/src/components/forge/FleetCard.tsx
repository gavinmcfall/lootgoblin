// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Human-friendly card for the Casual grid view.
// Canvas ref: FleetCardCasual (page-fleet.jsx line 63–127).

import { MetaBadge, Tile } from '@/components/shell/atoms';
import { PrinterDot } from './PrinterDot';
import { PrinterGlyph } from './PrinterGlyph';
import { printerKindLabel, printerStateLabel, STATE_TONE, type PrinterState } from './forge-labels';

export interface FleetCardProps {
  id: string;
  name: string;
  kind: string;
  state: PrinterState;
  /** Protocol string e.g. 'fdm_klipper' — shown as MetaBadge. */
  protocol: string;
  /** Active dispatch job loot name, if printing. */
  jobName?: string;
  /** Progress 0–1, if printing. */
  progress?: number;
  /** ETA string e.g. '3h 12m', if printing. */
  eta?: string;
  /** Whether the printer ACL is disabled. */
  disabled?: boolean;
}

export function FleetCard({ id: _id, name, kind, state, protocol, jobName, progress, eta, disabled }: FleetCardProps) {
  const tone = STATE_TONE[state];
  const isOffline = state === 'offline' || state === 'disabled';
  const glyphColor = isOffline ? 'text-fg-faint' : 'text-fg';

  return (
    <Tile className={`p-[18px] flex flex-col gap-3.5 ${isOffline ? 'opacity-55' : ''}`}>
      {/* Header */}
      <div className="flex items-start gap-3.5">
        <PrinterGlyph kind={kind} size={48} colorClass={glyphColor} />
        <div className="flex-1 min-w-0">
          <div className="font-sans text-[15px] font-semibold text-fg leading-[1.2] truncate">
            {name}
          </div>
          <div className="flex items-center gap-2 mt-[5px]">
            <PrinterDot state={state} />
            <MetaBadge tone={tone}>
              {disabled ? <span className="italic">{printerStateLabel(state)}</span> : printerStateLabel(state)}
            </MetaBadge>
            <span className="font-mono text-[9.5px] text-fg-faint uppercase tracking-[0.8px]">
              {printerKindLabel(kind)}
            </span>
          </div>
        </div>
      </div>

      {/* Job detail if running */}
      {jobName && (
        <div className="font-sans text-[12.5px] text-fg-muted leading-[1.5] truncate">
          {jobName}
        </div>
      )}

      {/* Protocol badge */}
      {!jobName && (
        <div className="font-mono text-[10.5px] text-fg-faint">
          {protocol}
        </div>
      )}

      {/* Progress bar if printing */}
      {progress != null && (
        <div>
          <div className="h-[5px] rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full bg-running rounded-full"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 font-mono text-[10px] text-fg-faint">
            <span>{Math.round(progress * 100)}%</span>
            {eta && <span>ETA {eta}</span>}
          </div>
        </div>
      )}

      {/* Footer — connection info */}
      <div className="pt-2.5 border-t border-dashed border-hairline">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.8px] text-fg-faint">
          {/* TODO: Courier pillar (V3+) will show Courier name + state here */}
          local LAN
        </span>
      </div>
    </Tile>
  );
}
