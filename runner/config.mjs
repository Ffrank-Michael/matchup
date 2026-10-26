// Settings for the round runner. All times are in seconds.
// Made for the testnet's 10-minute rounds (600 s) and works for any round length. Each market is staggered:
// today BTC locks at :00, ETH at :03, SOL at :06 of every 10 minutes.
export const FEED_DECIMALS = 8;

export const CFG = {
  // --- when the house agents bet (round k can be bet on from lock(k-1) until lock(k)) ---
  earlyDelay: 60,        // trend follower, chart reader and coin flipper bet 1 minute after the round opens
  earlyCutoff: 60,       // ... and not in the last minute before lock
  contrarianAfterEarly: 30, // the contrarian starts looking 30 s after the early agents are due, in a round of any length, so there is a crowd to bet against
  contrarianCutoff: 30,  // ... keeps looking until 30 s before lock (an empty or even crowd is looked at again each tick), and never later

  // --- when test prices are pushed (the feed owner is the deployer wallet); rule H5 in docs/RULES.md ---
  // Two prices per round per market: the START price and the END price (no price in the middle).
  // Fairness: the START price must be a trade that happens AFTER calling closes, so nobody can know it when they
  // call. It is the first Bitfinex trade whose own time is at least startAfter seconds after the lock, pushed as
  // soon as it is seen (usually 5 to 15 s after the lock, longer on a quiet market). If none has come by
  // startGiveUp of the round, no start price is recorded and the round refunds.
  startAfter: 2,         // the start trade must be at least this many seconds after the lock (covers clock differences)
  startGiveUp: 0.25,     // ... and the runner stops waiting for it after this share of the round
  endMargin: 60,         // the last trade is pushed this long before the end: it becomes the END price. A push takes about 13 s on the testnet
                         // (two transactions), so this leaves at least 30 s to spare even when the network is slow. The log shows each landing.

  // --- settling and claiming ---
  settleWindow: 3600,    // the contract only allows settling for 1 hour after a round ends
  lookback: 8,           // how many past rounds each tick looks at (8 x 10 minutes covers the 1-hour settle window)

  // --- money safety ---
  gasReserve: 50_000,    // 0.05 USDC an agent always keeps for fees (on Arc the gas is USDC too)
  approveAmount: 10_000_000, // each approval lets the contract take up to 10 USDC from that agent
  maxStake: 10_000_000,  // beta limit: no bet above 10 USDC per call, whatever an agent decides (the site enforces the same limit)

  tickSeconds: 10,       // how often the runner looks at the chain
  fastTickSeconds: 3,    // ... and this often while a start or end price is due (Bitfinex allows one request per 5 s per market; the price module enforces it)
};
