# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Mnkjv/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Mnkjv/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A mean-reversion trading bot for Coinbase Wrapped BTC (cbBTC) on Solana. It buys dips below the 4-hour moving average — only while that average is not falling — and sells on reversion, trading paper money in make.fun's live 24-hour race. Dev-window grade: +$6.62 net PnL on $1,000 paper USDC, 2 trades, max drawdown 0.60% (the dev window was a −2.8% down day; every kit baseline lost money on it).

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout: the make.fun harness sends one JSON line per 1-minute bar and the bot answers with buy and sell orders. Grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=468n119g&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
