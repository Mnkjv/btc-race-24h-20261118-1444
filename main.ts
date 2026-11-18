// Mean-reversion cbBTC bot for make.fun btc-race-24h-20261118-1444.
//
// Protocol: agent-fun/bars-replay/v1, long only, $1,000 paper USDC, one asset
// (CBBTC, 1-minute bars from an Orca Whirlpool).
//
// Idea: on 1-minute bars BTC is mostly noise (about 6 bps per minute) around a
// slowly moving 4-hour mean, while a full round trip costs about 26 bps in
// fees, slippage and price impact. So the bot trades rarely and only for
// moves much larger than the cost:
//
// - Buy a dip: the close at least DIP_BPS below the 240-bar (4h) simple
//   moving average, while that average is not falling at all (trend guard).
// - Sell on reversion: the close back above the average, or a take-profit
//   of TP_BPS over cost, or a stop-loss of STOP_BPS under cost.
// - One full-size position at a time (up to 100% of equity), no pyramiding.
// - Equity guard: if equity falls 10% from its peak, flatten and stop
//   trading for the rest of the window (protects the 25% drawdown bar).
//
// Tuned on this race's dev window (a -2.8% day; every baseline loses):
// DIP 70-80 bps and trend guard -20..0 bps form a stable plateau, all
// giving the same single winning round trip; DIP=70/TP=80/EXIT=80 chosen.
// Dev grade: +$6.62 net PnL, 2 trades, max drawdown 0.60%, +$5.82 at 2x fees.
// A momentum breakout leg was tried and dropped: it added trades but cut
// the 2x-fee margin to +$0.29.
//
// Everything is deterministic: plain float64 arithmetic over the closes in
// arrival order, no clock, no randomness, no files, no network.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (basis points unless noted) ---
const SMA_LEN = 240; // 4 hours of 1-minute bars
const DIP_BPS = 70; // buy when the close is 0.70% under the 4h mean
const EXIT_ABOVE_BPS = 80; // sell when the close is back 0.80% over the mean
const TP_BPS = 80; // take profit: +0.80% over the position's cost
const STOP_BPS = 80; // stop loss: -0.80% under the position's cost
const TREND_LOOKBACK = 60; // bars over which the 4h mean's slope is measured
const TREND_MIN_BPS = 0; // do not buy a dip while the mean is falling at all
const EQUITY_GUARD_BPS = 1000; // halt after a 10% drawdown from peak equity
const MAX_SLIPPAGE_BPS = 100;

const BPS = 10_000;

/** The strategy's running state: closes, the 4h mean and its history. */
class MeanReversion {
  /** Last SMA_LEN closes, oldest first, with their running sum. */
  window: number[] = [];
  windowSum = 0;
  /** SMA value after each bar, once seeded. */
  smaHist: number[] = [];
  peakEquity: bigint | null = null;
  halted = false;

  /** Feed one close; returns the current SMA or null until seeded. */
  push(close: number): number | null {
    this.window.push(close);
    this.windowSum += close;
    if (this.window.length > SMA_LEN) this.windowSum -= this.window.shift()!;
    if (this.window.length < SMA_LEN) return null;
    const sma = this.windowSum / SMA_LEN;
    this.smaHist.push(sma);
    return sma;
  }

  /** Slope of the SMA over TREND_LOOKBACK bars, in bps, or null until known. */
  smaSlopeBps(): number | null {
    if (this.smaHist.length <= TREND_LOOKBACK) return null;
    const now = this.smaHist[this.smaHist.length - 1]!;
    const ago = this.smaHist[this.smaHist.length - 1 - TREND_LOOKBACK]!;
    if (ago === 0) return null;
    return ((now - ago) * BPS) / ago;
  }
}

const strat = new MeanReversion();

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Equity guard bookkeeping (runs on every batch, fresh bar or not).
    if (strat.peakEquity === null) strat.peakEquity = state.equity;
    else if (state.equity > strat.peakEquity) strat.peakEquity = state.equity;

    // Only decide on a bar this batch actually carries.
    let bar = null;
    for (const b of batch.bars) if (b.symbol === SYMBOL) bar = b;
    if (bar === null || state.warmingUp) return [];
    const close = Number(bar.c);
    const sma = strat.push(close);
    if (sma === null) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      // Equity guard: flatten and halt for the rest of the window.
      if (state.equity * BigInt(BPS) <= strat.peakEquity! * BigInt(BPS - EQUITY_GUARD_BPS)) {
        strat.halted = true;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      const reverted = close >= sma * (1 + EXIT_ABOVE_BPS / BPS);
      const takeProfit = value * BigInt(BPS) >= cost * BigInt(BPS + TP_BPS);
      const stopLoss = value * BigInt(BPS) <= cost * BigInt(BPS - STOP_BPS);
      if (reverted || takeProfit || stopLoss) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: look for a dip to buy.
    if (strat.halted) return [];
    const slope = strat.smaSlopeBps();
    if (slope === null) return [];
    const dipped = close <= sma * (1 - DIP_BPS / BPS);
    const trendOk = slope >= TREND_MIN_BPS;
    if (dipped && trendOk) {
      const room = state.weightRoom(SYMBOL);
      const spend = state.cash < room ? state.cash : room;
      if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
