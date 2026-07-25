/**
 * OrderTicket — order entry.
 *
 * Keyboard first. A player who has to move a mouse between the size box and the
 * buy button has already lost the fill, so every control here has a hotkey and
 * the hotkeys are printed on the controls rather than hidden in a help modal.
 *
 * The order type control is a segmented switch, not a dropdown, for the same
 * reason: a dropdown costs two clicks and hides its current value behind the
 * closed state, and "am I about to send a market order?" is not a question the
 * UI should make anyone guess at.
 */

import { useEffect, useState } from 'react';
import { Side, OrderType, TimeInForce, formatPrice, formatMoney } from '@shared/protocol';
import type { AccountState, BookSnapshot } from '@shared/protocol';

interface Props {
  book: BookSnapshot;
  account: AccountState;
  precision: number;
  maxOrderQty: number;
  disabled: boolean;
  /** Set by clicking the ladder; null means "follow the touch price". */
  priceOverride: number | null;
  onPriceChange: (p: number | null) => void;
  onSubmit: (o: { side: Side; type: OrderType; tif: TimeInForce; price: number; qty: number }) => void;
  onFlatten: () => void;
  onCancelAll: () => void;
}

const QTY_PRESETS = [1, 5, 10, 25, 50, 100];

export function OrderTicket({
  book, account, precision, maxOrderQty, disabled,
  priceOverride, onPriceChange, onSubmit, onFlatten, onCancelAll,
}: Props) {
  const [qty, setQty] = useState(10);
  const [type, setType] = useState<OrderType>(OrderType.Limit);
  const [tif, setTif] = useState<TimeInForce>(TimeInForce.GTC);

  const bid = book.bestBid;
  const ask = book.bestAsk;
  const price = priceOverride ?? bid ?? ask ?? 0;

  const send = (side: Side) => {
    if (disabled || qty <= 0) return;
    // A market order's price field is ignored by the engine, but sending a
    // stale one anyway invites a future refactor to start honouring it.
    const px = type === OrderType.Market ? 0 : price;
    onSubmit({
      side, type, price: px, qty,
      tif: type === OrderType.Market ? TimeInForce.IOC : tif,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'b': e.preventDefault(); send(Side.Buy); break;
        case 's': e.preventDefault(); send(Side.Sell); break;
        case 'f': e.preventDefault(); onFlatten(); break;
        case 'escape': e.preventDefault(); onCancelAll(); break;
        case 'm': e.preventDefault(); setType((t) => (t === OrderType.Market ? OrderType.Limit : OrderType.Market)); break;
        case 'arrowup': e.preventDefault(); onPriceChange(price + 1); break;
        case 'arrowdown': e.preventDefault(); onPriceChange(price - 1); break;
        case '1': case '2': case '3': case '4': case '5': case '6': {
          const preset = QTY_PRESETS[Number(e.key) - 1];
          if (preset) { e.preventDefault(); setQty(preset); }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const notional = price * qty;

  return (
    <div className="ticket">
      <div className="ticket-seg">
        <button
          className={type === OrderType.Limit ? 'seg on' : 'seg'}
          onClick={() => setType(OrderType.Limit)}
        >Limit</button>
        <button
          className={type === OrderType.Market ? 'seg on' : 'seg'}
          onClick={() => setType(OrderType.Market)}
        >Market <kbd>M</kbd></button>
      </div>

      <div className="ticket-field">
        <span className="label">Size</span>
        <div className="row gap-4">
          <button className="btn btn-sm" onClick={() => setQty((q) => Math.max(1, q - 1))}>–</button>
          <input
            className="num"
            type="number"
            min={1}
            max={maxOrderQty}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(maxOrderQty, Number(e.target.value) || 1)))}
          />
          <button className="btn btn-sm" onClick={() => setQty((q) => Math.min(maxOrderQty, q + 1))}>+</button>
        </div>
        <div className="preset-row">
          {QTY_PRESETS.map((p, i) => (
            <button
              key={p}
              className={qty === p ? 'preset on' : 'preset'}
              onClick={() => setQty(p)}
              title={`Hotkey ${i + 1}`}
            >{p}</button>
          ))}
        </div>
      </div>

      {type === OrderType.Limit && (
        <div className="ticket-field">
          <span className="label">Price <kbd>↑↓</kbd></span>
          <div className="row gap-4">
            <button className="btn btn-sm" onClick={() => onPriceChange(price - 1)}>–</button>
            <input
              className="num"
              value={formatPrice(price, precision)}
              onChange={(e) => {
                const parsed = Math.round(Number(e.target.value.replace(/[^0-9.-]/g, '')) * 10 ** precision);
                if (Number.isFinite(parsed)) onPriceChange(parsed);
              }}
            />
            <button className="btn btn-sm" onClick={() => onPriceChange(price + 1)}>+</button>
          </div>
          <div className="preset-row">
            <button className="preset" onClick={() => onPriceChange(bid)} disabled={bid === null}>Bid</button>
            <button className="preset" onClick={() => onPriceChange(ask)} disabled={ask === null}>Ask</button>
            <button className="preset" onClick={() => onPriceChange(null)}>Auto</button>
          </div>
        </div>
      )}

      {type === OrderType.Limit && (
        <div className="ticket-field">
          <span className="label">Time in force</span>
          <div className="ticket-seg tif">
            {([
              [TimeInForce.GTC, 'GTC', 'Rests until filled or cancelled'],
              [TimeInForce.IOC, 'IOC', 'Fill what you can, cancel the rest'],
              [TimeInForce.FOK, 'FOK', 'All or nothing'],
              [TimeInForce.PostOnly, 'POST', 'Maker only — rejected if it would cross'],
            ] as const).map(([v, label, title]) => (
              <button
                key={label}
                className={tif === v ? 'seg on' : 'seg'}
                onClick={() => setTif(v)}
                title={title}
              >{label}</button>
            ))}
          </div>
        </div>
      )}

      <div className="ticket-meta">
        <span className="faint">Notional</span>
        <span className="num">{formatMoney(notional * 10_000)}</span>
        <span className="faint">Buying power</span>
        <span className="num">{formatMoney(account.buyingPower)}</span>
      </div>

      <div className="ticket-actions">
        <button className="btn btn-buy btn-block" disabled={disabled} onClick={() => send(Side.Buy)}>
          BUY <kbd>B</kbd>
        </button>
        <button className="btn btn-sell btn-block" disabled={disabled} onClick={() => send(Side.Sell)}>
          SELL <kbd>S</kbd>
        </button>
      </div>

      <div className="ticket-actions">
        <button className="btn btn-sm btn-block" disabled={disabled} onClick={onCancelAll}>
          Cancel all <kbd>Esc</kbd>
        </button>
        <button
          className="btn btn-sm btn-block"
          disabled={disabled || account.position === 0}
          onClick={onFlatten}
        >
          Flatten <kbd>F</kbd>
        </button>
      </div>
    </div>
  );
}
