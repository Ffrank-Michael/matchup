// Settings for the round runner. All times are in seconds.
// Made for the testnet's 10-minute rounds (600 s). Each market is staggered by 3 minutes:
// BTC locks at :00, ETH at :03, SOL at :06 of every 10 minutes.
export const FEED_DECIMALS = 8;

export const CFG = {
  // --- when the house agents bet (round k can be bet on from lock(k-1) until lock(k)) ---
  earlyDelay: 60,        // trend follower, streak hunter and coin flipper bet 1 minute after the round opens
  earlyCutoff: 60,       // ... and not in the last minute before lock
  contrarianLead: 120,   // the contrarian bets about 2 minutes before lock, so there is a crowd to bet against
  contrarianCutoff: 30,  // ... and never in the last 30 seconds

  // --- when test prices are pushed (the feed owner is the deployer wallet) ---
  // About 3 prices per round per market (the website shows the live price straight from the price API).
  // Fairness: the START price must not be a price from before the lock, or someone watching the market just
  // before lock would know which way it is already leaning. Prices are the last trade on Bitfinex (the same
  // number the website shows). The delays below were chosen for CoinGecko's lag (13 to 89 s); with an exchange
  // feed they are more careful than strictly needed, and they stay as approved (the site says about 2 minutes).
  startDelay: 90,        // first try at the START price this long after lock (a new quote is usually ready by then) ...
  startQuoteMargin: 30,  // ... and the quote (Bitfinex's clock) must be at least this long AFTER the lock, or nothing is pushed (retried every 20 s)
  midAt: 300,            // one price in the middle of the round
  midCutoff: 60,         // no mid price in the last minute (plus endMargin) before the end
  endMargin: 30,         // last price this long before the end: it becomes the END price

  // --- settling and claiming ---
  settleWindow: 3600,    // the contract only allows settling for 1 hour after a round ends
  lookback: 8,           // how many past rounds each tick looks at (8 x 10 minutes covers the 1-hour settle window)

  // --- money safety ---
  gasReserve: 50_000,    // 0.05 USDC an agent always keeps for fees (on Arc the gas is USDC too)
  approveAmount: 10_000_000, // each approval lets the contract take up to 10 USDC from that agent
  maxStake: 1_000_000,   // no bet above 1 USDC, whatever an agent decides

  tickSeconds: 10,
};
