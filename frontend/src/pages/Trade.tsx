/**
 * Trade — the live match screen. Used by PvP and solo practice unchanged.
 *
 * Layout is a fixed three-column grid, and it does not reflow as data arrives.
 * A trading screen whose panels resize when a number gets wider is a screen you
 * cannot build muscle memory on, and muscle memory is most of what separates a
 * good execution from a late one.
 *
 * Column order — chart, ladder, ticket — puts the ladder in the middle because
 * it is both the primary read AND the primary click target, so it should be the
 * shortest mouse travel from anywhere.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Side, formatPrice, formatMoney } from '@shared/protocol';
import { useMatch, visibleOrders } from '@/state/match';
import { OrderBookLadder } from '@/components/trade/OrderBookLadder';
import { PriceChart } from '@/components/trade/PriceChart';
import { EquityRace } from '@/components/trade/EquityRace';
import { OrderTicket } from '@/components/trade/OrderTicket';
import {
  PositionPanel, Tape, OrdersPanel, FillBlotter, OpponentPanel, MatchClock,
} from '@/components/trade/panels';
import { socket } from '@/lib/socket';
import '@/components/trade/trade.css';

const REGIME_BLURB: Record<string, string> = {
  Calm: 'Tight spread, deep book. Passive execution pays.',
  Trending: 'Persistent drift. Fading strength is expensive here.',
  Choppy: 'Mean reverting. Overtrading the range is the trap.',
  Volatile: 'Wide spread, thin book. Size down.',
  LiquidityGap: 'One side of the book is gone. Mind your exits.',
  NewsSpike: 'Instant repricing. Resting orders got run over.',
  FlashCrash: 'Cascade in progress. Survival first.',
  Squeeze: 'Grinding up with no pullback. Shorts are in trouble.',
};

export function Trade() {
  const navigate = useNavigate();
  const { phase, arm, frame, candles, tape, fills, countdownMs, optimisticCancels } = useMatch();
  const sendOrder = useMatch((s) => s.sendOrder);
  const cancelOrder = useMatch((s) => s.cancelOrder);
  const cancelAll = useMatch((s) => s.cancelAll);
  const flatten = useMatch((s) => s.flatten);
  const leaveMatch = useMatch((s) => s.leaveMatch);

  const [priceOverride, setPriceOverride] = useState<number | null>(null);
  const [blotterTab, setBlotterTab] = useState<'orders' | 'fills'>('orders');
  const [myCurve, setMyCurve] = useState<{ tMs: number; equity: number }[]>([]);
  const [oppCurve, setOppCurve] = useState<{ tMs: number; equity: number }[]>([]);

  useEffect(() => {
    if (phase === 'ended') navigate('/result');
  }, [phase, navigate]);

  // Equity curves are accumulated client-side from the per-frame sample. The
  // server also keeps them for the result screen; this copy exists so the
  // in-match race chart works without a second round trip.
  useEffect(() => {
    if (!frame) return;
    setMyCurve((c) => [...c, frame.equityPoint].slice(-400));
    if (frame.opponent) {
      setOppCurve((c) => [...c, { tMs: frame.tMs, equity: frame.opponent!.equity }].slice(-400));
    }
  }, [frame?.seq]);

  useEffect(() => {
    if (arm) {
      setMyCurve([]);
      setOppCurve([]);
      setPriceOverride(null);
    }
  }, [arm?.matchId]);

  const orders = useMemo(
    () => visibleOrders(frame, optimisticCancels),
    [frame, optimisticCancels],
  );

  if (!arm) {
    return (
      <div className="page">
        <div className="panel"><div className="panel-body">
          <p className="dim">No match in progress.</p>
          <button className="btn btn-primary" onClick={() => navigate('/play')}>Find a match</button>
        </div></div>
      </div>
    );
  }

  const precision = arm.instrument.displayPrecision;
  const isCountdown = phase === 'countdown' || !frame;
  const avgEntryTicks = frame && frame.account.position !== 0
    ? frame.account.avgEntryMicros / arm.instrument.tickValueMicros
    : null;
  const pnl = frame ? frame.account.equity - arm.startingCash : 0;

  return (
    <div className="trade">
      {isCountdown && (
        <div className="countdown-veil">
          <div className="countdown-card">
            <span className="label">{arm.mode === 'practice' ? 'Practice' : 'Match'} starting</span>
            <div className="countdown-num num">{Math.ceil(countdownMs / 1000) || 'GO'}</div>
            <div className="countdown-scenario">{arm.scenario.label}</div>
            {arm.opponent && (
              <div className="countdown-vs">
                vs <strong>{arm.opponent.handle}</strong> <span className="faint">({arm.opponent.elo})</span>
              </div>
            )}
            {arm.drill && <p className="dim countdown-brief">{arm.drill.description}</p>}
          </div>
        </div>
      )}

      {/* ---- header ------------------------------------------------------ */}
      <header className="trade-bar">
        <div className="tb-left">
          <span className="tb-symbol">{arm.instrument.symbol}</span>
          <span className="tb-price num">
            {formatPrice(frame?.book.lastTrade ?? arm.scenario.openPrice, precision)}
          </span>
          <span className={`tb-pnl num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
            {formatMoney(pnl, { sign: pnl > 0 })}
          </span>
        </div>

        <div className="tb-mid">
          {frame && <MatchClock frame={frame} durationMs={arm.durationMs} />}
        </div>

        <div className="tb-right">
          {frame && (
            <span className="chip chip-violet" title={REGIME_BLURB[frame.regime]}>
              {frame.regime}
            </span>
          )}
          <span className="chip" title="Round-trip time to the match server">
            {socket.latencyMs} ms
          </span>
          <button className="btn btn-sm" onClick={() => { leaveMatch(); navigate('/'); }}>
            {arm.mode === 'practice' ? 'End run' : 'Forfeit'}
          </button>
        </div>
      </header>

      {frame && REGIME_BLURB[frame.regime] && (
        <div className="regime-strip">{REGIME_BLURB[frame.regime]}</div>
      )}

      {/* ---- body -------------------------------------------------------- */}
      <div className="trade-grid">
        {/* left: chart + blotter */}
        <section className="col col-chart">
          <div className="panel flex-fill">
            <div className="panel-head">
              <span>Price</span>
              <span className="faint">
                {arm.scenario.label} · difficulty {arm.scenario.difficulty}/10
              </span>
            </div>
            <PriceChart
              candles={candles}
              current={frame?.candle ?? null}
              fills={fills}
              precision={precision}
              avgEntryTicks={avgEntryTicks}
              height={310}
            />
          </div>

          {arm.opponent && (
            <div className="panel">
              <div className="panel-head"><span>P&amp;L race</span></div>
              <EquityRace
                height={132}
                durationMs={arm.durationMs}
                curves={[
                  { label: 'You', color: '#22d3ee', points: myCurve, baseline: arm.startingCash },
                  { label: arm.opponent.handle, color: '#a855f7', points: oppCurve, baseline: arm.startingCash },
                ]}
              />
            </div>
          )}

          <div className="panel blotter">
            <div className="panel-head">
              <div className="tabs">
                <button
                  className={blotterTab === 'orders' ? 'tab on' : 'tab'}
                  onClick={() => setBlotterTab('orders')}
                >Working ({orders.length})</button>
                <button
                  className={blotterTab === 'fills' ? 'tab on' : 'tab'}
                  onClick={() => setBlotterTab('fills')}
                >Fills ({fills.length})</button>
              </div>
            </div>
            <div className="blotter-body">
              {blotterTab === 'orders'
                ? <OrdersPanel orders={orders} precision={precision} onCancel={cancelOrder} />
                : <FillBlotter fills={fills} precision={precision} />}
            </div>
          </div>
        </section>

        {/* middle: ladder + tape */}
        <section className="col col-ladder">
          <div className="panel flex-fill">
            <div className="panel-head">
              <span>Depth</span>
              <span className="faint">click to work an order</span>
            </div>
            {frame && (
              <OrderBookLadder
                book={frame.book}
                precision={precision}
                openOrders={orders}
                avgEntryTicks={avgEntryTicks}
                onPriceClick={(p) => setPriceOverride(p)}
                onCancelAt={(p, side) => {
                  for (const o of orders) if (o.price === p && o.side === side) cancelOrder(o.orderId);
                }}
              />
            )}
          </div>
          <div className="panel tape-panel">
            <div className="panel-head"><span>Tape</span></div>
            <Tape prints={tape} precision={precision} />
          </div>
        </section>

        {/* right: ticket + account + opponent */}
        <section className="col col-ticket">
          <div className="panel">
            <div className="panel-head"><span>Order</span></div>
            <div className="panel-body">
              {frame && (
                <OrderTicket
                  book={frame.book}
                  account={frame.account}
                  precision={precision}
                  maxOrderQty={arm.instrument.maxOrderQty}
                  disabled={phase !== 'live'}
                  priceOverride={priceOverride}
                  onPriceChange={setPriceOverride}
                  onSubmit={sendOrder}
                  onFlatten={flatten}
                  onCancelAll={cancelAll}
                />
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><span>Account</span></div>
            <div className="panel-body">
              {frame && (
                <PositionPanel
                  account={frame.account}
                  precision={precision}
                  startingCash={arm.startingCash}
                />
              )}
            </div>
          </div>

          {frame?.opponent && (
            <div className="panel">
              <div className="panel-head"><span>Opponent</span></div>
              <div className="panel-body">
                <OpponentPanel opponent={frame.opponent} myPnl={pnl} />
              </div>
            </div>
          )}

          {arm.drill && (
            <div className="panel">
              <div className="panel-head"><span>Objectives</span></div>
              <div className="panel-body stack gap-8">
                {arm.drill.objectives.map((o) => (
                  <div key={o.id} className="objective">
                    <span className="obj-dot" />
                    <span>{o.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export const SIDE_LABEL = { [Side.Buy]: 'BUY', [Side.Sell]: 'SELL' };
