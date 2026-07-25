/**
 * PriceChart — candles, volume, own fills, break-even line.
 *
 * Canvas rather than SVG or a chart library. At 10 Hz with 200 candles, SVG
 * means 200+ DOM nodes reconciled ten times a second while the player is
 * clicking a ladder, and the jank lands exactly where responsiveness matters
 * most. Canvas redraws the whole scene in one pass and does not touch the DOM.
 *
 * The fill markers are the point of the chart, not decoration. "Where did I get
 * in relative to what the market did next" is the question a trading game
 * exists to answer, and it is unanswerable from a P&L number alone.
 */

import { useEffect, useRef } from 'react';
import { Side, formatPrice, type Candle, type FillEvent } from '@shared/protocol';

interface Props {
  candles: Candle[];
  current: Candle | null;
  fills: FillEvent[];
  precision: number;
  avgEntryTicks?: number | null;
  height?: number;
  /** ms of match time per candle — needed to place fills on the x axis. */
  candleMs?: number;
}

const PAD_R = 62;
const PAD_T = 10;
const PAD_B = 18;
const VOL_FRAC = 0.18;

export function PriceChart({
  candles, current, fills, precision, avgEntryTicks, height = 300, candleMs = 1000,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = height;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const series = current ? [...candles, current] : candles;
    if (series.length === 0) {
      ctx.fillStyle = '#5b678a';
      ctx.font = '12px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for the tape…', w / 2, h / 2);
      return;
    }

    const plotW = w - PAD_R;
    const volH = (h - PAD_T - PAD_B) * VOL_FRAC;
    const priceH = h - PAD_T - PAD_B - volH;

    let lo = Infinity;
    let hi = -Infinity;
    for (const c of series) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    if (avgEntryTicks != null) {
      lo = Math.min(lo, avgEntryTicks);
      hi = Math.max(hi, avgEntryTicks);
    }
    // A flat market must not render as a single line at the top of the pane.
    if (hi - lo < 4) {
      const mid = (hi + lo) / 2;
      lo = mid - 2;
      hi = mid + 2;
    }
    const padRange = (hi - lo) * 0.08;
    lo -= padRange;
    hi += padRange;

    const maxVol = Math.max(1, ...series.map((c) => c.v));
    const y = (price: number) => PAD_T + priceH - ((price - lo) / (hi - lo)) * priceH;
    const n = series.length;
    const slot = plotW / Math.max(n, 40);
    const bodyW = Math.max(1.5, Math.min(9, slot * 0.66));
    const x = (i: number) => i * slot + slot / 2;

    // ---- grid + price axis --------------------------------------------------
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.fillStyle = '#5b678a';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    const GRID = 5;
    for (let i = 0; i <= GRID; i++) {
      const p = lo + ((hi - lo) * i) / GRID;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(formatPrice(Math.round(p), precision), plotW + 7, yy + 3);
    }

    // ---- volume -------------------------------------------------------------
    const volBase = h - PAD_B;
    for (let i = 0; i < n; i++) {
      const c = series[i];
      const vh = (c.v / maxVol) * volH;
      ctx.fillStyle = c.c >= c.o ? 'rgba(34,197,94,0.28)' : 'rgba(244,63,94,0.28)';
      ctx.fillRect(x(i) - bodyW / 2, volBase - vh, bodyW, vh);
    }

    // ---- candles ------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const c = series[i];
      const up = c.c >= c.o;
      const col = up ? '#22c55e' : '#f43f5e';
      const cx = x(i);

      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y(c.h));
      ctx.lineTo(Math.round(cx) + 0.5, y(c.l));
      ctx.stroke();

      const yo = y(c.o);
      const yc = y(c.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillStyle = col;
      ctx.fillRect(cx - bodyW / 2, top, bodyW, bh);
    }

    // ---- break-even ---------------------------------------------------------
    if (avgEntryTicks != null) {
      const yy = Math.round(y(avgEntryTicks)) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(252,211,77,0.8)';
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#fcd34d';
      ctx.fillRect(plotW + 2, yy - 7, PAD_R - 4, 14);
      ctx.fillStyle = '#0b0d16';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(formatPrice(Math.round(avgEntryTicks), precision), plotW + 6, yy + 3);
    }

    // ---- last price tag -----------------------------------------------------
    const last = series[n - 1];
    const lastY = Math.round(y(last.c)) + 0.5;
    const lastUp = last.c >= last.o;
    ctx.fillStyle = lastUp ? '#22c55e' : '#f43f5e';
    ctx.fillRect(plotW + 2, lastY - 8, PAD_R - 4, 16);
    ctx.fillStyle = '#05070f';
    ctx.font = 'bold 10.5px ui-monospace, monospace';
    ctx.fillText(formatPrice(last.c, precision), plotW + 6, lastY + 3.5);

    // ---- own fills ----------------------------------------------------------
    const firstT = series[0].t;
    for (const f of fills) {
      const tMs = f.tsNs / 1e6;
      const idx = (tMs - firstT) / candleMs;
      if (idx < -0.5 || idx > n) continue;
      const fx = x(Math.max(0, Math.min(n - 1, idx)));
      const fy = y(f.price);
      const buy = f.side === Side.Buy;
      ctx.fillStyle = buy ? '#22c55e' : '#f43f5e';
      ctx.strokeStyle = '#05070f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Triangles: up for a buy, down for a sell. Shape, not just colour —
      // roughly one player in twelve cannot rely on the colour alone.
      if (buy) {
        ctx.moveTo(fx, fy - 5);
        ctx.lineTo(fx - 4.5, fy + 3);
        ctx.lineTo(fx + 4.5, fy + 3);
      } else {
        ctx.moveTo(fx, fy + 5);
        ctx.lineTo(fx - 4.5, fy - 3);
        ctx.lineTo(fx + 4.5, fy - 3);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }, [candles, current, fills, precision, avgEntryTicks, height, candleMs]);

  return (
    <div style={{ width: '100%', height }}>
      <canvas ref={ref} />
    </div>
  );
}
