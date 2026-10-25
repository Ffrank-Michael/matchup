// Settings for the round runner. All times are in seconds.
export const FEED_DECIMALS = 8;

export const CFG = {
  // --- when the house agents bet (round k can be bet on from lock(k-1) until lock(k)) ---
  earlyDelay: 60,        // trend follower, streak hunter and coin flipper bet this long after the round opens
  earlyCutoff: 60,       // ... and not in the last minute before lock
  contrarianLead: 300,   // the contrarian bets about 5 minutes before lock, so there is a crowd to bet against
  contrarianCutoff: 30,  // ... and never in the last 30 seconds

  // --- when test prices are pushed (the feed owner is the deployer wallet) ---
  startDelay: 3,         // first price this long after lock: it becomes the START price
  endMargin: 30,         // last price this long before the end: it becomes the END price
  midInterval: 1200,     // a price in between every 20 minutes, so the feed looks alive
  midCutoff: 60,         // no mid price in the last minute before the end

  // --- settling and claiming ---
  settleWindow: 3600,    // the contract only allows settling for 1 hour after a round ends
  lookback: 6,           // how many past rounds each tick looks at

  // --- money safety ---
  gasReserve: 50_000,    // 0.05 USDC an agent always keeps for fees (on Arc the gas is USDC too)
  approveAmount: 10_000_000, // each approval lets the contract take up to 10 USDC from that agent
  maxStake: 1_000_000,   // no bet above 1 USDC, whatever an agent decides

  tickSeconds: 10,
};

// Where the test prices start. These are made-up TEST PRICES, not real market data.
export const START_PRICES = { 'BTC/USD': 100000, 'ETH/USD': 3500, 'SOL/USD': 150 };
