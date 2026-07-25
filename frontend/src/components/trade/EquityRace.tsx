/**
 * EquityRace — the head-to-head P&L chart.
 *
 * This is the scoreboard, and in a PvP match it is the only thing on screen
 * that says whether you are winning. It plots P&L, not equity: a $100,000
 * baseline compresses a $400 lead into a flat line, and the lead is the story.
 *
 * Also used on the results screen with both curves, and in-match with the
 * opponent's sampled curve alongside yours.
 */

import { useEffect, useRef } from 'react';
import { formatCompactMoney } from '@shared/protocol';

export interface Curve {
  label: string;
  color: string;
  points: { tMs: number; equity: number }[];
  baseline: number;
}

interface Props {
  curves: Curve[];
  height?: number;
  durationMs?: number;
}

const PAD_L = 4;
const PAD_R = 58;
const PAD_T = 12;
const PAD_B = 16;

export function EquityRace({ curves, height = 150, durationMs }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);

    const series = curves.filter((c) => c.points.length > 0);
    if (series.length === 0) {
      ctx.fillStyle = '#5b678a';
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('No data yet', w / 2, height / 2);
      return;
    }

    let lo = 0;
    let hi = 0;
    let maxT = durationMs ?? 1;
    for (const c of series) {
      for (const p of c.points) {
        const pnl = p.equity - c.baseline;
        if (pnl < lo) lo = pnl;
        if (pnl > hi) hi = pnl;
        if (p.tMs > maxT) maxT = p.tMs;
      }
    }
    // Always show zero, and never let a near-flat curve fill the pane with noise.
    const span = Math.max(hi - lo, 20_000_000);
    const mid = (hi + lo) / 2;
    lo = mid - span * 0.62;
    hi = mid + span * 0.62;

    const plotW = w - PAD_L - PAD_R;
    const plotH = height - PAD_T - PAD_B;
    const x = (t: number) => PAD_L + (t / maxT) * plotW;
    const y = (v: number) => PAD_T + plotH - ((v - lo) / (hi - lo)) * plotH;

    // Zero line — the only reference that matters.
    const zeroY = Math.round(y(0)) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD_L, zeroY);
    ctx.lineTo(PAD_L + plotW, zeroY);
    ctx.stroke();

    ctx.fillStyle = '#5b678a';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(formatCompactMoney(hi), PAD_L + plotW + 6, PAD_T + 8);
    ctx.fillText('$0', PAD_L + plotW + 6, zeroY + 3);
    ctx.fillText(formatCompactMoney(lo), PAD_L + plotW + 6, PAD_T + plotH);

    for (const c of series) {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      c.points.forEach((p, i) => {
        const px = x(p.tMs);
        const py = y(p.equity - c.baseline);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      const last = c.points[c.points.length - 1];
      const lx = x(last.tMs);
      const ly = y(last.equity - c.baseline);
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(lx, ly, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [curves, height, durationMs]);

  return (
    <div style={{ width: '100%', height }}>
      <canvas ref={ref} />
    </div>
  );
}
