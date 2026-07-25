/**
 * The smaller trade-screen panels: position, tape, blotter, opponent.
 * Grouped in one file because none of them is big enough to earn its own, and
 * they all change together whenever the frame shape changes.
 */

import {
  Side, formatMoney, formatPrice, formatCompactMoney,
  type AccountState, type TradePrint, type FillEvent, type OpenOrder,
  type OpponentView, type MatchFrame,
} from '@shared/protocol';

// ---------------------------------------------------------------------------
export function PositionPanel({
  account, precision, startingCash,
}: { account: AccountState; precision: number; startingCash: number }) {
  const pnl = account.equity - startingCash;
  const flat = account.position === 0;
  const avgTicks = flat ? null : Math.round(account.avgEntryMicros / 10_000);

  return (
    <div className="stats-grid">
      <Stat label="P&L" value={formatMoney(pnl, { sign: pnl > 0 })} tone={pnl > 0 ? 'up' : pnl < 0 ? 'down' : undefined} big />
      <Stat label="Equity" value={formatMoney(account.equity)} />
      <Stat
        label="Position"
        value={flat ? 'FLAT' : `${account.position > 0 ? '+' : ''}${account.position}`}
        tone={account.position > 0 ? 'up' : account.position < 0 ? 'down' : undefined}
      />
      <Stat label="Avg entry" value={avgTicks === null ? '—' : formatPrice(avgTicks, precision)} />
      <Stat label="Realized" value={formatMoney(account.realizedPnl, { sign: account.realizedPnl > 0 })} />
      <Stat label="Unrealized" value={formatMoney(account.unrealizedPnl, { sign: account.unrealizedPnl > 0 })} />
      <Stat label="Margin held" value={formatMoney(account.reservedMargin)} />
      <Stat label="Buying power" value={formatMoney(account.buyingPower)} />
    </div>
  );
}

function Stat({
  label, value, tone, big,
}: { label: string; value: string; tone?: 'up' | 'down'; big?: boolean }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`stat-v num ${tone ?? ''} ${big ? 'stat-big' : ''}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Tape({ prints, precision }: { prints: TradePrint[]; precision: number }) {
  return (
    <div className="tape">
      {prints.length === 0 && <div className="empty">No prints yet</div>}
      {prints.map((p) => (
        <div key={p.seq} className={`tape-row ${p.aggressor === Side.Buy ? 'up' : 'down'}`}>
          <span className="num">{formatPrice(p.price, precision)}</span>
          <span className="num tape-qty">{p.qty}</span>
          <span className="tape-arrow">{p.aggressor === Side.Buy ? '▲' : '▼'}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function OrdersPanel({
  orders, precision, onCancel,
}: { orders: OpenOrder[]; precision: number; onCancel: (id: number) => void }) {
  if (orders.length === 0) return <div className="empty">No working orders</div>;
  return (
    <table className="data compact">
      <thead>
        <tr><th>Side</th><th className="r">Price</th><th className="r">Left</th><th /></tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.orderId}>
            <td className={o.side === Side.Buy ? 'up' : 'down'}>
              {o.side === Side.Buy ? 'BUY' : 'SELL'}
            </td>
            <td className="r num">{formatPrice(o.price, precision)}</td>
            <td className="r num">{o.leaves}<span className="faint">/{o.qty}</span></td>
            <td className="r">
              <button className="btn btn-sm btn-ghost" onClick={() => onCancel(o.orderId)}>✕</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
export function FillBlotter({ fills, precision }: { fills: FillEvent[]; precision: number }) {
  if (fills.length === 0) return <div className="empty">No fills yet</div>;
  return (
    <table className="data compact">
      <thead>
        <tr>
          <th>Side</th><th className="r">Price</th><th className="r">Qty</th>
          <th>Liq</th><th className="r">P&L</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => (
          <tr key={f.seq}>
            <td className={f.side === Side.Buy ? 'up' : 'down'}>
              {f.side === Side.Buy ? 'BUY' : 'SELL'}
            </td>
            <td className="r num">{formatPrice(f.price, precision)}</td>
            <td className="r num">{f.qty}</td>
            <td>
              {/* Maker vs taker is the single most teachable stat in the game —
                  it belongs on every fill, not summarised at the end. */}
              <span className={`chip ${f.isMaker ? 'chip-cyan' : ''}`}>
                {f.isMaker ? 'MAKER' : 'TAKER'}
              </span>
            </td>
            <td className={`r num ${f.realizedDelta > 0 ? 'up' : f.realizedDelta < 0 ? 'down' : 'faint'}`}>
              {f.realizedDelta === 0 ? '—' : formatCompactMoney(f.realizedDelta)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
export function OpponentPanel({
  opponent, myPnl,
}: { opponent: OpponentView; myPnl: number }) {
  const lead = myPnl - opponent.pnl;
  return (
    <div className="opp">
      <div className="opp-head">
        <span className="opp-name">{opponent.handle}</span>
        {!opponent.connected && <span className="chip chip-ask pulsing">DISCONNECTED</span>}
      </div>
      <div className="opp-grid">
        <div>
          <span className="label">Their P&L</span>
          <div className={`num opp-num ${opponent.pnl > 0 ? 'up' : opponent.pnl < 0 ? 'down' : ''}`}>
            {formatMoney(opponent.pnl, { sign: opponent.pnl > 0 })}
          </div>
        </div>
        <div>
          <span className="label">Position</span>
          <div className="num opp-num">
            {opponent.position === 0 ? 'FLAT' : `${opponent.position > 0 ? '+' : ''}${opponent.position}`}
          </div>
        </div>
        <div>
          <span className="label">Fills</span>
          <div className="num opp-num">{opponent.fills}</div>
        </div>
      </div>
      <div className={`opp-lead ${lead > 0 ? 'up' : lead < 0 ? 'down' : ''}`}>
        {lead === 0 ? 'DEAD EVEN' : lead > 0
          ? `YOU LEAD BY ${formatMoney(lead)}`
          : `BEHIND BY ${formatMoney(-lead)}`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function MatchClock({ frame, durationMs }: { frame: MatchFrame; durationMs: number }) {
  const s = Math.ceil(frame.remainingMs / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const pct = durationMs > 0 ? (frame.tMs / durationMs) * 100 : 0;
  // The last thirty seconds change behaviour, so they change appearance.
  const urgent = frame.remainingMs <= 30_000;
  return (
    <div className={`clock ${urgent ? 'clock-urgent' : ''}`}>
      <div className="clock-time num">{mm}:{ss}</div>
      <div className="clock-bar"><div className="clock-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
