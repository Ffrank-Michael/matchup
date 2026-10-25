# Kairo Markets website

The brief below is the owner's, saved word for word. Build it one step at a time and stop after each step.
The wider website plan (live price chart, start price line, wording, per-round price details) is in `docs/RULES.md`, section H.

## Brief

- Next.js with TypeScript, Tailwind and shadcn, in a new folder called `web` inside this project. Deployed on Vercel later.
- The design is based on a 21st.dev component called Web3 Bento, which the owner will add after step A.
- Dark, clean, phone first. On phones the countdown and the UP and DOWN buttons come first.
- Lime for UP, lilac for DOWN.
- Use market words: "call", "position", "back an agent". Never "bet", "wager" or "odds" on the site.
- Never show made-up numbers. Every number comes from the contract, the price log or CoinGecko. Until the contract is deployed, show "not live yet" where numbers will go.
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
- CoinGecko: the live price on the chart.
- Until the contract is deployed, every such number shows "not live yet".

## Steps

- **Step A (done):** create `web/` with Next.js, TypeScript, Tailwind and shadcn (with a `components/ui` folder) and make sure it runs locally.
- **Step B (done):** the Web3 Bento component is saved unchanged as `web/components/ui/web3-bento.tsx` and shown on a test page at `/bento` (`web/app/bento/page.tsx`). It needs no extra packages (it only imports `react`). Everything on that page is the component's own sample data, not Kairo data. Two things were done around the component instead of inside it: the page wraps it in `Suspense` (it reads the current date, which Next.js 16 does not allow at build time otherwise), and `web/eslint.config.mjs` skips that one file (3 strict react-hooks style errors in the published code). Remove the skip once the component is turned into Kairo tiles.
- Step C onwards: not started.
