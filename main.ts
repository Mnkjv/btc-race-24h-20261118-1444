// Mean-reversion dip buyer for cbBTC (agent-fun/bars-replay/v1).
//
// Idea: on one-minute bars the pool price wobbles around a slow rolling mean.
// When the latest close dips far enough below that mean, buy with a fixed
// slice of equity; when the price reverts through the mean (plus a wide margin),
// or a take-profit / stop-loss against the actual fill price triggers, sell
// everything. One position at a time, long only, fully deterministic: all
// comparisons are exact bigint cross-multiplications, no floats, no clock,
// no randomness.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (basis points unless noted). Tuned on the dev window.
const MEAN_BARS = 120; // rolling mean window, in bars
const ENTRY_DIP_BPS = 110; // buy when close <= mean * (1 - 110 bps): only deep overshoots
const EXIT_GAIN_BPS = 240; // sell when close >= mean * (1 + 240 bps): a full recovery, margin set
// wide on purpose so a deep-dip position is held through the reversion instead of
// being sold the first time it touches the mean; the take-profit below binds first.
const TAKE_PROFIT_BPS = 220; // or when close >= entry fill * (1 + 220 bps)
const STOP_LOSS_BPS = 100; // or when close <= entry fill * (1 - 100 bps)
const TIME_STOP_BARS = 600; // or after 600 bars in the position, whatever it shows
const LAST_ENTRY_SEQ = 1250; // no new positions from here on: too little window left
// for a dip to revert before the end-of-window flatten takes the position out.
const SPEND_BPS = 6000; // spend 60% of equity on one position
const ORDER_SLIPPAGE_BPS = 400; // max_slippage_bps sent with every order
const GUARD_DD_BPS = 1000; // stop opening trades once equity is 10% under its peak
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

const BPS_WHOLE = 10_000n;

class DipBuyer {
  closes: bigint[] = [];
  sum = 0n;
  peakEquity = 0n;
  entryPrice: bigint | null = null;
  entrySeq = -1;
  orderInFlight = false;
  orderSeq = 0;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fills of the orders decided on the previous batch arrive with this one;
    // fold them in first so entryPrice tracks the real fill price.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy' && fill.symbol === SYMBOL) {
        this.entryPrice = BigInt(fill.price);
        this.entrySeq = batch.seq;
      } else if (fill.side === 'sell' && fill.symbol === SYMBOL) {
        this.entryPrice = null;
        this.entrySeq = -1;
      }
    }
    this.orderInFlight = false;

    if (state.equity > this.peakEquity) this.peakEquity = state.equity;

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);

    this.closes.push(close);
    this.sum += close;
    if (this.closes.length > MEAN_BARS) {
      this.sum -= this.closes.shift() as bigint;
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const heldQty = held === undefined ? 0n : held.qty;

    if (heldQty > 0n) {
      if (this.entryPrice === null) this.entryPrice = this.costPrice(state);
      if (this.shouldSell(close, batch.seq)) {
        this.orderInFlight = true;
        return [
          {
            side: 'sell',
            client_id: this.nextId('exit'),
            symbol: SYMBOL,
            qty: heldQty,
            max_slippage_bps: ORDER_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // Flat: look for a dip. Guard first: no new risk far under the peak.
    if (this.peakEquity > 0n && state.equity * BPS_WHOLE <= this.peakEquity * (BPS_WHOLE - BigInt(GUARD_DD_BPS))) {
      return [];
    }
    if (batch.seq >= LAST_ENTRY_SEQ) return [];
    if (this.closes.length < MEAN_BARS) return [];
    if (!this.isDip(close)) return [];

    const spendByEquity = (state.equity * BigInt(SPEND_BPS)) / BPS_WHOLE;
    const room = state.weightRoom(SYMBOL);
    let notional = spendByEquity < state.cash ? spendByEquity : state.cash;
    if (room < notional) notional = room;
    if (notional < MIN_NOTIONAL) return [];

    this.orderInFlight = true;
    return [
      {
        side: 'buy',
        client_id: this.nextId('dip'),
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: ORDER_SLIPPAGE_BPS,
      },
    ];
  }

  // close <= mean * (1 - ENTRY_DIP_BPS), with mean = sum / count, cross-multiplied.
  isDip(close: bigint): boolean {
    const count = BigInt(this.closes.length);
    return close * count * BPS_WHOLE <= this.sum * (BPS_WHOLE - BigInt(ENTRY_DIP_BPS));
  }

  // close >= mean * (1 + EXIT_GAIN_BPS), cross-multiplied the same way.
  isReverted(close: bigint): boolean {
    const count = BigInt(this.closes.length);
    return close * count * BPS_WHOLE >= this.sum * (BPS_WHOLE + BigInt(EXIT_GAIN_BPS));
  }

  shouldSell(close: bigint, seq: number): boolean {
    if (this.entrySeq >= 0 && seq - this.entrySeq >= TIME_STOP_BARS) return true;
    if (this.isReverted(close)) return true;
    const entry = this.entryPrice;
    if (entry === null || entry <= 0n) return false;
    if (close * BPS_WHOLE >= entry * (BPS_WHOLE + BigInt(TAKE_PROFIT_BPS))) return true;
    if (close * BPS_WHOLE <= entry * (BPS_WHOLE - BigInt(STOP_LOSS_BPS))) return true;
    return false;
  }

  // Average price implied by the position's cost basis, at the price scale:
  // cost = qty * price * 10^quote_scale / 10^(qty_scale + price_scale).
  costPrice(state: BarsState): bigint | null {
    const held = state.positions.get(SYMBOL);
    const sym = state.symbols.get(SYMBOL);
    if (held === undefined || sym === undefined || held.qty <= 0n) return null;
    const num = held.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale);
    const den = held.qty * 10n ** BigInt(state.hello.capital.quote_scale);
    return den === 0n ? null : num / den;
  }

  nextId(kind: string): string {
    this.orderSeq += 1;
    return `${kind}-${this.orderSeq}`;
  }
}

const bot = new DipBuyer();

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    return bot.onBatch(state, batch);
  },
});
