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
| Card stack | the four agents as cards: Agent 1 · Trend Follower, Agent 2 · Contrarian, Agent 3 · Chart Reader, Agent 4 · Coin Flipper |
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
4. **The lime "Your call" panel (big):** large UP and DOWN buttons; the amount in large numbers with quick buttons ($1, $5, $10, default $1) and a field to type your own amount ("Minimum 0.10 USDC", beta limit 10 USDC per call, shown with a small "Beta" label on the panel); an estimated payout, marked as changing until lock; a big "Confirm call" button; the countdown; and the fee and start-price notes (fee: "2% of winnings. If you lose or get refunded, you pay no fee."; start price: "UP wins if the end price is higher than the start price. The start price is recorded about 2 minutes after calling closes, so nobody can know it in advance.").
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
- **Step C1 (done):** Kairo page frame on the homepage. The /bento reference page and `web3-bento.tsx` were removed on 27 Oct 2026.
- **Step C2 (done):** homepage = three market cards, selected market in the middle, Agents and Live calls at the bottom. (First version used CoinGecko with a 7-day line; replaced in C3a.)
- **Step C3a (done):** one price feed for everything: Bitfinex websocket (`web/lib/price-feed.ts`) gives the live price (last trade), the last-hour line on cards and chart, and later the 1-minute candles. The runner uses the same Bitfinex last trade for its start, middle and end prices (`runner/exchangePrices.mjs`; CoinGecko removed). See docs/RULES.md H4. The countdown is computed from the schedule (lock = offset + k x 600 s), not read from the contract.
- **Step C4a (done, needs your test):** "Connect wallet" for Arc Testnet only (`web/components/kairo/wallet-button.tsx`, `web/lib/wagmi.ts`, `web/lib/arc.ts`; wagmi 3.7.7, viem 2.57.2, react-query 5.104.1, pinned). Wallets are found automatically (browser wallets; wallet apps when the page is opened in their built-in browser). After connecting, a wallet on another network is asked to switch, and to add Arc Testnet first if it does not have it (chain 5042002, RPC https://rpc.testnet.arc.io, explorer https://explorer.testnet.arc.io, USDC 18-decimal native view). A wrong-network wallet shows an amber "Wrong network · Switch" pill. From a normal phone browser (no wallet inside it) the window offers "Open in MetaMask / Coinbase Wallet / Trust Wallet" links (needs the public site). WalletConnect (QR code / any wallet app from a normal phone browser) needs a free project id and is NOT added yet.
- **Next:** Google / email sign-in (Circle user-controlled wallets). Then rebuild the page to the agreed layout above, one small step at a time (phone first).

## Agent avatars and cards (decided 2026-10-26, built)
- Each agent is an animated SVG avatar (`web/components/kairo/agent-avatar.tsx`, keyframes in `web/app/globals.css`): a glowing circle in the agent's colour with a loop that acts out its personality. Trend Follower (teal) a wave flowing forward; Contrarian (coral) a cluster of dots drifting one way and one bright dot the other way; Chart Reader (amber) three candlesticks growing one after another, the last one lit; Coin Flipper (sky blue) a coin flipping in 3D.
- Once an agent has made its call for the open round, its ring glows lime (UP) or lilac (DOWN). All animation stops for people who prefer reduced motion (they see a calm still pose).
- Each agent card (`whos-calling.tsx`): big avatar on the left, name, tagline (Rides the trend, Fades the crowd, Reads the chart, Leaves it to luck), the current call as a big UP or DOWN pill, the reason in quotes, win rate, profit, the last 5 calls as small dots, and a "Back this agent" button. Every number says "not live yet" until the contract is live (the card takes an `AgentLive` object from `web/lib/agents.ts`, empty for now).

## Time frames (decided 2026-10-26; NOT built yet)
- Each coin can have several markets with different round lengths. Each market card gets a row of time frame buttons (for example 5m, 15m, 1h) showing only the ones that exist on the network the site is pointed at. The list of markets comes from the deployment file / contract, never hard-coded in the screens.
- Which time frames exist, and the refund rates behind that choice, are in `docs/SUBMISSION.md` section "Time frames".

## Phone layout v2 (owner's feedback 2026-10-26, built; laptop unchanged)
Phone, top to bottom: (1) the three market cards in one row, each with a small last-hour line under the price (lime if the price rose over the hour, lilac if it fell); the selected card also shows the start price legend, and the start price line and the true "UP winning" or "DOWN winning" label only once the contract has recorded a start price (until then: "Start price: not live yet" and no label). (2) A small chart icon on the selected card opens the full chart in a panel that slides up from the bottom, with a Line / Candles toggle (1-minute Bitfinex candles); close with X, by swiping the top of the panel down, by tapping outside, or Escape. (3) A compact row of the four agent avatars; tap one to see how it decides (and its reason once live) and press "Back this agent". (4) The lime "Your call" panel; UP and DOWN look the same until one is tapped, then the chosen one fills in. (5) Live calls. (6) Your calls. (7) The full agent cards as a leaderboard. The big separate chart tile is gone from the phone.
Files: `market-card.tsx`, `chart-sheet.tsx`, `price-chart.tsx`, `agent-strip.tsx`, `call-pill.tsx`, `whos-calling.tsx`, `lib/winning.ts`.

## Agent avatars v2 and one set of components (owner's feedback 2026-10-26, built)
- **Avatars:** four robot heads that read as one team (same size, visor and chin lights), each slightly different (head corners, antenna, ears). The visor acts out the personality in a loop: Trend Follower (teal) a wave flowing across; Contrarian (orange) a row of small arrows going one way and one bigger arrow going the other way; Chart Reader (amber) three candlesticks with wicks growing one after another, the last one lit; Coin Flipper (sky blue) a coin with two different faces clearly flipping. The head outline glows lime (UP) or lilac (DOWN) once an agent has called. Animation stops for reduced motion. Phone labels are short: Trend, Contrarian, Chart, Coin Flip.
- **Same components on phone and laptop, only arranged differently:** market cards, the agent strip ("Who's calling?"), Your call, Live calls, Your calls, the agent leaderboard, and the full chart (a sheet from the bottom on a phone, a centred panel on a laptop). Phone is one column in that order. Laptop: cards; agents beside Your call; Live calls beside Your calls; the leaderboard as a row of four cards. (This replaces the earlier laptop-only "Who's calling?" tile with tabs.)

## Built 2026-10-26 (later)
- Call panel reads "Next round: UP or DOWN?" with a countdown to when the round starts; the start price note now says it is the first live trade after calling closes (usually within seconds) and that the call is judged from it.
- "How it works" page (`web/app/how-it-works/page.tsx`), linked from the top bar. The six steps are the owner's text with these accuracy changes: rounds are 5 or 10 minutes; the call is on the next round; the start price is the first live trade after calling closes; the money sits in the contract, not with Kairo (Kairo can only take its 2% fee).
- Laptop (changed 2026-10-26, back to the phone strip): the four agents are the same row of robot heads as on the phone, with the selected agent's details underneath, beside Your call; the space under them is kept for history later. Your call and the agent tile are only as tall as their content. The full agent cards are the leaderboard at the bottom on both. The step 3 text on How it works and the start price note in Your call were replaced with the owner's wording.
- The faucet link shows only when `NEXT_PUBLIC_NETWORK` is not `mainnet`.
