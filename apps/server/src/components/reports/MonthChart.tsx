'use client';
// MonthChart — pure inline SVG 12-month bar chart.
// Canvas ref: MonthChart (page-consumption.jsx line 159–195).
// Measured (solid) + estimated (running, 0.45 opacity) stacked bars.

import { EmptyHint } from '@/components/shell/atoms';

interface MonthDatum {
  /** 3-letter month abbreviation e.g. "Jan" */
  m: string;
  /** Total mass in kg */
  mass: number;
  /** Estimated portion in kg */
  est: number;
}

interface Props {
  data: MonthDatum[];
  /** SVG height in px. Default 200. */
  h?: number;
}

export function MonthChart({ data, h = 200 }: Props) {
  if (data.length === 0) return <EmptyHint>No monthly data available.</EmptyHint>;

  const max = Math.max(...data.map((d) => d.mass), 0.01);
  const w = 660;
  const padL = 36;
  const padR = 16;
  const padT = 14;
  const padB = 28;
  const innerH = h - padT - padB;
  const innerW = w - padL - padR;
  const barW = innerW / data.length;

  const peak = data.reduce(
    (best, d) => (best === undefined || d.mass > best.mass ? d : best),
    undefined as MonthDatum | undefined,
  );
  const ariaLabel = peak
    ? `12-month consumption time series, peak month ${peak.m} with ${peak.mass.toFixed(2)} kg`
    : '12-month consumption time series';

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={ariaLabel}
      style={{ width: '100%', height: h, display: 'block' }}
    >
      {/* Gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
        const y = padT + innerH * (1 - p);
        return (
          <g key={i}>
            <line
              x1={padL}
              y1={y}
              x2={w - padR}
              y2={y}
              stroke="var(--hairline)"
              strokeDasharray={p === 0 ? '' : '2 3'}
            />
            <text
              x={padL - 6}
              y={y + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--fg-faint)"
              fontFamily="var(--font-mono)"
            >
              {(max * p).toFixed(1)}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const x = padL + i * barW + 4;
        const bw = barW - 8;
        const measured = d.mass - d.est;
        const yMeas = padT + innerH * (1 - measured / max);
        const hMeas = padT + innerH - yMeas;
        const yEst = padT + innerH * (1 - d.mass / max);
        const hEst = padT + innerH - yEst - hMeas;
        const isCurrent = i === data.length - 1;
        return (
          <g key={i}>
            {/* Estimated portion (lighter) */}
            {hEst > 0 && (
              <rect
                x={x}
                y={yEst}
                width={bw}
                height={hEst}
                fill="var(--running)"
                opacity="0.45"
              />
            )}
            {/* Measured portion */}
            {hMeas > 0 && (
              <rect
                x={x}
                y={yMeas}
                width={bw}
                height={hMeas}
                fill={isCurrent ? 'var(--accent)' : 'var(--fg)'}
                opacity={isCurrent ? 1 : 0.78}
              />
            )}
            {/* Month label */}
            <text
              x={x + bw / 2}
              y={h - padB + 14}
              textAnchor="middle"
              fontSize="9.5"
              fill={isCurrent ? 'var(--fg)' : 'var(--fg-faint)'}
              fontFamily="var(--font-mono)"
            >
              {d.m}
            </text>
          </g>
        );
      })}

      {/* Unit label */}
      <text
        x={w - padR}
        y={padT + 8}
        textAnchor="end"
        fontSize="9.5"
        fill="var(--fg-faint)"
        fontFamily="var(--font-mono)"
      >
        kg
      </text>
    </svg>
  );
}
