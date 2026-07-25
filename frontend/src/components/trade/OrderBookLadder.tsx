/**
 * OrderBookLadder — the depth-of-market ladder.
 *
 * Three design choices worth stating, because each has a cheaper alternative
 * that is worse in a way that only shows up under time pressure:
 *
 * 1. PRICE ROWS ARE POSITIONALLY STABLE. The ladder is anchored on a price
 *    range, not on "top N levels". If rows re-sort under the cursor every tick,
 *    a player aiming at 100.05 clicks 100.06 instead. That is a real fill at a
 *    real wrong price, caused entirely by the UI.
 *
 * 2. THE DEPTH BAR IS SIZE, THE NUMBER IS ALSO SIZE. Redundant on purpose. The
 *    bar is for peripheral vision — where is the wall — and the number is for
 *    the decision. During a fast tape nobody reads five-digit sizes.
 *
 * 3. YOUR OWN RESTING SIZE IS MARKED SEPARATELY. Knowing that 40 of the 260
 *    lots on the bid are yours is the difference between "there is support
 *    here" and "I am the support here", and the aggregated number cannot say it.
 */

import { useMemo } from 'react';
import { Side, formatPrice, type BookSnapshot, type OpenOrder } from '@shared/protocol';
import './ladder.css';

interface Props {
  book: BookSnapshot;
  precision: number;
  openOrders: OpenOrder[];
  /** Ladder half-height in ticks; total rows = 2 * span + 1. */
  span?: number;
  onPriceClick?: (price: number, side: Side) => void;
  onCancelAt?: (price: number, side: Side) => void;
  avgEntryTicks?: number | null;
}

export function OrderBookLadder({
  book, precision, openOrders, span = 11, onPriceClick, onCancelAt, avgEntryTicks,
}: Props) {
  const center = useMemo(() => {
    if (book.bestBid !== null && book.bestAsk !== null) {
      return Math.round((book.bestBid + book.bestAsk) / 2);
    }
    return book.lastTrade ?? book.bestBid ?? book.bestAsk ?? 0;
  }, [book.bestBid, book.bestAsk, book.lastTrade]);

  const { rows, maxQty } = useMemo(() => {
    const bidMap = new Map(book.bids.map((l) => [l.price, l]));
    const askMap = new Map(book.asks.map((l) => [l.price, l]));
    const mineByPrice = new Map<number, { buy: number; sell: number }>();
    for (const o of openOrders) {
      const e = mineByPrice.get(o.price) ?? { buy: 0, sell: 0 };
      if (o.side === Side.Buy) e.buy += o.leaves;
      else e.sell += o.leaves;
      mineByPrice.set(o.price, e);
    }

    const out = [];
    let max = 1;
    for (let p = center + span; p >= center - span; p--) {
      const bid = bidMap.get(p);
      const ask = askMap.get(p);
      const mine = mineByPrice.get(p);
      max = Math.max(max, bid?.qty ?? 0, ask?.qty ?? 0);
      out.push({
        price: p,
        bidQty: bid?.qty ?? 0,
        askQty: ask?.qty ?? 0,
        myBid: mine?.buy ?? 0,
        myAsk: mine?.sell ?? 0,
        isBest: p === book.bestBid || p === book.bestAsk,
        isLast: p === book.lastTrade,
      });
    }
    return { rows: out, maxQty: max };
  }, [book, openOrders, center, span]);

  const avgRow = avgEntryTicks != null ? Math.round(avgEntryTicks) : null;

  return (
    <div className="ladder">
      <div className="ladder-head">
        <span>Bid</span>
        <span className="ladder-head-px">Price</span>
        <span>Ask</span>
      </div>
      <div className="ladder-rows">
        {rows.map((r) => (
          <div
            key={r.price}
            className={[
              'lrow',
              r.isBest ? 'lrow-best' : '',
              r.isLast ? 'lrow-last' : '',
              avgRow === r.price ? 'lrow-avg' : '',
            ].join(' ')}
          >
            <button
              className={`lcell lcell-bid ${r.myBid ? 'has-mine' : ''}`}
              onClick={() => (r.myBid ? onCancelAt?.(r.price, Side.Buy) : onPriceClick?.(r.price, Side.Buy))}
              title={r.myBid ? `Cancel your ${r.myBid} lots bid` : `Bid ${formatPrice(r.price, precision)}`}
            >
              <span
                className="lbar lbar-bid"
                style={{ width: `${Math.min(100, (r.bidQty / maxQty) * 100)}%` }}
              />
              {r.myBid > 0 && <span className="lmine lmine-bid">{r.myBid}</span>}
              <span className="lqty num">{r.bidQty || ''}</span>
            </button>

            <div className="lcell lcell-px num">
              {formatPrice(r.price, precision)}
            </div>

            <button
              className={`lcell lcell-ask ${r.myAsk ? 'has-mine' : ''}`}
              onClick={() => (r.myAsk ? onCancelAt?.(r.price, Side.Sell) : onPriceClick?.(r.price, Side.Sell))}
              title={r.myAsk ? `Cancel your ${r.myAsk} lots offered` : `Offer ${formatPrice(r.price, precision)}`}
            >
              <span
                className="lbar lbar-ask"
                style={{ width: `${Math.min(100, (r.askQty / maxQty) * 100)}%` }}
              />
              <span className="lqty num">{r.askQty || ''}</span>
              {r.myAsk > 0 && <span className="lmine lmine-ask">{r.myAsk}</span>}
            </button>
          </div>
        ))}
      </div>
      <div className="ladder-foot">
        <span className="label">Spread</span>
        <span className="num">
          {book.bestBid !== null && book.bestAsk !== null
            ? `${book.bestAsk - book.bestBid} tick${book.bestAsk - book.bestBid === 1 ? '' : 's'}`
            : '—'}
        </span>
        <span className="label">Micro</span>
        <span className="num">{formatPrice(book.microPrice, precision)}</span>
      </div>
    </div>
  );
}
