# Kairo Markets website

The brief below is the owner's, saved word for word. Build it one step at a time and stop after each step.
The wider website plan (live price chart, start price line, wording, per-round price details) is in `docs/RULES.md`, section H.

## Brief

- Next.js with TypeScript, Tailwind and shadcn, in a new folder called `web` inside this project. Deployed on Vercel later.
- The design is based on a 21st.dev component called Web3 Bento, which the owner will add after step A.
- Dark, clean, phone first. On phones the countdown and the UP and DOWN buttons come first.
- Lime for UP, lilac for DOWN.
- Use market words: "call", "position", "back an agent". Never "bet", "wager" or "odds" on the site.
- Never show made-up numbers. Every number comes from the contract, the price log or Bitfinex (the one price feed). Until the contract is deployed, show "not live yet" where numbers will go.
- The homepage leads with the agents and the live rounds, not a betting slip.

### How the Web3 Bento tiles become Kairo

| Web3 Bento tile | Becomes |
|---|---|
| Hero (greeting and net worth) | the live round: market, countdown to lock, total pot |
| 30-day PnL bars | the last 30 rounds: lime for UP wins, lilac for DOWN |
| Card stack | the four agents as cards: Agent 1 · Trend Follower, Agent 2 · Contrarian, Agent 3 · Streak Hunter, Agent 4 · Coin Flipper |
| Gas gauge | an UP vs DOWN meter for the current round |
| Portfolio vs ETH chart | each agent's profit vs the coin flipper |
| Allocation bar | how this round's pot splits between UP and DOWN |
| Staking tile | the main "Make your call" tile with the UP and DOWN buttons |
| Liquidity range | start price vs live price |
| Block stream | the round history |
| Onchain activity | a live feed of calls with each agent's one-line reason |

Also follow the website plan already in `docs/RULES.md`: live price chart, start price line, the UP/DOWN wording, the fee line, and the per-round price details with explorer links.

## Where the numbers come from (so nothing is made up)

- The contract (rounds, pots, positions, results), once it is deployed.
- The public price log (`data/price-log.jsonl`, written by the runner): start/mid/end prices, source, times, transaction links.
- Bitfinex (websocket, `web/lib/price-feed.ts`): the live price on the cards and the chart, the same market the runner uses for start, middle and end prices.
- Until the contract is deployed, every such number shows "not live yet".

## Agreed layout (decided 2026-10-25; NOT built yet, only the Connect wallet button exists)

The site is PHONE FIRST, with a separate laptop layout. Design the phone first. Anything that needs the contract shows "not live yet" until it is deployed.

### Phone (top to bottom)
1. **Markets:** the three markets as three small cards in ONE row, all visible with no swiping: ticker, price and countdown. Tap to select; the selected one gets the lime border. The row only swipes sideways when there are more than three markets.
2. **Selected market, bigger:** the live line for the last hour, the start price line after lock, and an "UP winning" or "DOWN winning" label.
3. **"Who's calling?"** with two tabs:
   - **Back an agent:** the four agents as rows, each with its colour, icon, name, current call, one-line reason and win rate. Tapping one puts its call into the lime panel.
   - **My own call.**
4. **The lime "Your call" panel (big):** large UP and DOWN buttons; the amount in large numbers with quick buttons ($0.25, $0.50, $1); an estimated payout, marked as changing until lock; a big "Confirm call" button; the countdown; and the fee and start-price notes (fee: "2% of winnings. If you lose or get refunded, you pay no fee."; start price: "UP wins if the end price is higher than the start price. The start price is recorded about 2 minutes after calling closes, so nobody can know it in advance.").
5. **Live calls:** every call as it comes in: the agent's name or a short wallet address, side, amount, market, time, and the agent's reason.
6. **Your calls:** the connected wallet's open calls; finished ones marked won, lost or refunded; and a "Claim all" button. Before connecting it says "Connect your wallet to see your calls."

### Laptop
- **Row 1:** the three market cards, bigger, with sparklines. The selected card gets the start price line after lock and the "UP winning" label. There is NO separate big price chart.
- **Row 2, half and half:** "Who's calling?" and the lime "Your call" panel. The "Your call" panel must be the most obvious thing on the page.
- **Row 3:** Live calls and Your calls.

### Sign in
Two options:
- **"Continue with Google"** (or email), using Circle user-controlled wallets. Comes later.
- **"Connect wallet"** for MetaMask, Rabby and others. Built first, for Arc testnet only (see below).

### Earlier ideas that still apply
Line / Candles toggle with 1-minute candles (Bitfinex candles are already in the feed), the countdown ring that turns urgent in the last minute, a soft glow on the selected market, a colour and a simple icon for each agent, and no "bet", "wager" or "odds" anywhere on the site.

## Steps

- **Step A (done):** create `web/` with Next.js, TypeScript, Tailwind and shadcn (with a `components/ui` folder) and make sure it runs locally.
- **Step B (done):** the Web3 Bento component is saved unchanged as `web/components/ui/web3-bento.tsx` and shown on a test page at `/bento` (`web/app/bento/page.tsx`). It needs no extra packages (it only imports `react`). Everything on that page is the component's own sample data, not Kairo data. Two things were done around the component instead of inside it: the page wraps it in `Suspense` (it reads the current date, which Next.js 16 does not allow at build time otherwise), and `web/eslint.config.mjs` skips that one file (3 strict react-hooks style errors in the published code). Remove the skip once the component is turned into Kairo tiles.
- **Step C1 (done):** Kairo page frame on the homepage; /bento kept as reference.
- **Step C2 (done):** homepage = three market cards, selected market in the middle, Agents and Live calls at the bottom. (First version used CoinGecko with a 7-day line; replaced in C3a.)
- **Step C3a (done):** one price feed for everything: Bitfinex websocket (`web/lib/price-feed.ts`) gives the live price (last trade), the last-hour line on cards and chart, and later the 1-minute candles. The runner uses the same Bitfinex last trade for its start, middle and end prices (`runner/exchangePrices.mjs`; CoinGecko removed). See docs/RULES.md H4. The countdown is computed from the schedule (lock = offset + k x 600 s), not read from the contract.
- **Step C4a (done, needs your test):** "Connect wallet" for Arc Testnet only (`web/components/kairo/wallet-button.tsx`, `web/lib/wagmi.ts`, `web/lib/arc.ts`; wagmi 3.7.7, viem 2.57.2, react-query 5.104.1, pinned). Wallets are found automatically (browser wallets; wallet apps when the page is opened in their built-in browser). After connecting, a wallet on another network is asked to switch, and to add Arc Testnet first if it does not have it (chain 5042002, RPC https://rpc.testnet.arc.io, explorer https://explorer.testnet.arc.io, USDC 18-decimal native view). A wrong-network wallet shows an amber "Wrong network · Switch" pill. From a normal phone browser (no wallet inside it) the window offers "Open in MetaMask / Coinbase Wallet / Trust Wallet" links (needs the public site). WalletConnect (QR code / any wallet app from a normal phone browser) needs a free project id and is NOT added yet.
- **Next:** Google / email sign-in (Circle user-controlled wallets). Then rebuild the page to the agreed layout above, one small step at a time (phone first).
