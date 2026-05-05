import React, { useState } from 'react';
import type { WeeklyBar } from '../oss-trends.js';

interface Props {
  bars: WeeklyBar[];
}

const WIDTH = 760;
const HEIGHT = 180;
const PAD_LEFT = 32;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const GROUP_GAP = 0.2;
const INNER_GAP = 0.15;

function niceMax(raw: number): number {
  if (raw <= 1) return 1;
  if (raw <= 5) return 5;
  if (raw <= 10) return 10;
  if (raw <= 20) return 20;
  const step = Math.pow(10, Math.floor(Math.log10(raw)));
  return Math.ceil(raw / step) * step;
}

export function OssWeeklyBars({ bars }: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const rawMax = bars.reduce((m, b) => Math.max(m, b.opened, b.merged), 0);
  const yMax = niceMax(rawMax);
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const groupW = bars.length > 0 ? plotW / bars.length : 0;
  const groupInner = groupW * (1 - GROUP_GAP);
  const barW = (groupInner * (1 - INNER_GAP)) / 2;

  const yFor = (v: number) => PAD_TOP + plotH - (v / yMax) * plotH;
  const x0 = (i: number) => PAD_LEFT + i * groupW + (groupW - groupInner) / 2;

  const tickCount = 3;
  const ticks: number[] = [];
  for (let t = 0; t <= tickCount; t++) ticks.push(Math.round((yMax * t) / tickCount));

  return (
    <div className="oss-weekly-bars-wrapper">
      <div className="oss-weekly-legend" aria-hidden="true">
        <span className="oss-legend-opened">● Opened</span>
        <span className="oss-legend-merged">● Merged</span>
      </div>
      <svg
        className="oss-weekly-bars"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Weekly opened and merged PRs"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* y-axis tick labels + horizontal guide lines */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={yFor(t)}
              y2={yFor(t)}
              className="oss-chart-gridline"
            />
            <text
              x={PAD_LEFT - 6}
              y={yFor(t) + 4}
              textAnchor="end"
              className="oss-chart-ylabel"
            >
              {t}
            </text>
          </g>
        ))}

        {/* bars */}
        {bars.map((b, i) => {
          const openedY = yFor(b.opened);
          const mergedY = yFor(b.merged);
          const baseY = yFor(0);
          const gx = x0(i);
          return (
            <g key={b.weekStart}>
              {/* hover hit area */}
              <rect
                x={PAD_LEFT + i * groupW}
                y={PAD_TOP}
                width={groupW}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
              />
              <rect
                className="oss-bar-opened"
                x={gx}
                y={openedY}
                width={barW}
                height={Math.max(0, baseY - openedY)}
              />
              <rect
                className="oss-bar-merged"
                x={gx + barW + groupInner * INNER_GAP}
                y={mergedY}
                width={barW}
                height={Math.max(0, baseY - mergedY)}
              />
            </g>
          );
        })}

        {/* x-axis labels */}
        {bars.map((b, i) => {
          const cx = x0(i) + groupInner / 2;
          // Thin labels: show every Nth label when many weeks
          const step = bars.length > 8 ? 2 : 1;
          if (i % step !== 0 && i !== bars.length - 1) return null;
          return (
            <text
              key={`xl-${b.weekStart}`}
              x={cx}
              y={HEIGHT - PAD_BOTTOM + 16}
              textAnchor="middle"
              className="oss-chart-xlabel"
            >
              {b.weekLabel}
            </text>
          );
        })}
      </svg>

      {hoverIdx !== null && bars[hoverIdx] && (
        <div className="oss-weekly-tooltip">
          <strong>Week of {bars[hoverIdx].weekLabel}</strong>
          <span>Opened: {bars[hoverIdx].opened}</span>
          <span>Merged: {bars[hoverIdx].merged}</span>
        </div>
      )}

      {/* Hidden accessible table for screen readers */}
      <table className="oss-weekly-sr-table">
        <caption>Weekly opened and merged PRs</caption>
        <thead>
          <tr>
            <th>Week</th>
            <th>Opened</th>
            <th>Merged</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.weekStart}>
              <td>{b.weekLabel}</td>
              <td>{b.opened}</td>
              <td>{b.merged}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
