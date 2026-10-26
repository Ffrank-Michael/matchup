// The market lists for the deploy script (and for the tests that keep them honest).
// Two sets, the same six markets: BTC, ETH and SOL at 5 minutes and at 10 minutes.
//   rehearsal : Arc TESTNET. Each coin has a test "Chainlink stand-in" (a MockPriceFeed we fill) as the guard.
//   mainnet   : Arc MAINNET. Each coin's guard is Chainlink's own proxy on Arc (checked on chain before anything is deployed).
// One GuardedRelayFeed per coin serves both of that coin's markets (docs/SUBMISSION.md, "Mainnet plan v3").
// Band: how far a pushed price may be from the guard's latest answer, in basis points (100 = 1%).
export const MIN_STAKE = 100_000n; // 0.10 USDC, the contract minimum on every market
export const FEED_DECIMALS = 8;
export const MAX_GUARD_AGE_SECONDS = 26 * 3600; // the relay's own limit (MAX_GUARD_AGE in GuardedRelayFeed.sol)

export const COINS = {
  btc: { pair: 'BTC/USD', label: 'BTC / USD', bandBps: 100 },
  eth: { pair: 'ETH/USD', label: 'ETH / USD', bandBps: 150 },
  sol: { pair: 'SOL/USD', label: 'SOL / USD', bandBps: 150 },
};

// Chainlink data feed proxies on Arc mainnet (chain 5042), 8 decimals. Verified 2026-10-26, see docs/SUBMISSION.md.
export const CHAINLINK_MAINNET = {
  btc: '0xa109B535C70C8Be9995be64Bb6751AcDB27e03De',
  eth: '0x50FCDD99D6762D1C170DC6A9111db944AEE6D364',
  sol: '0x2d04D354f5fDaE3De723df475745B0a9B4edf90C',
};

// Round length and lock offset (seconds) of each market. A coin uses the same offset for both time frames, so its 5 and
// 10 minute rounds start and end together and one price push serves both; the three coins are 100 s apart, so no two
// coins ever need a price at the same second.
const SHAPES = [
  { coin: 'btc', round: 300, offset: 0 },
  { coin: 'eth', round: 300, offset: 100 },
  { coin: 'sol', round: 300, offset: 200 },
  { coin: 'btc', round: 600, offset: 0 },
  { coin: 'eth', round: 600, offset: 100 },
  { coin: 'sol', round: 600, offset: 200 },
  // 30 minutes and 1 hour (added 26 Oct, after the first six, so the markets already deployed keep their ids). Same offsets: all
  // time frames of a coin line up with its 5-minute rounds, so one price push still serves every market of the coin.
  { coin: 'btc', round: 1800, offset: 0 },
  { coin: 'eth', round: 1800, offset: 100 },
  { coin: 'sol', round: 1800, offset: 200 },
  { coin: 'btc', round: 3600, offset: 0 },
  { coin: 'eth', round: 3600, offset: 100 },
  { coin: 'sol', round: 3600, offset: 200 },
];

export const SETS = {
  rehearsal: { network: 'testnet', markets: SHAPES },
  mainnet: { network: 'mainnet', markets: SHAPES },
};

export const marketName = (m) => `${COINS[m.coin].pair} ${m.round % 3600 === 0 ? `${m.round / 3600}h` : `${m.round / 60}m`}`;
const percent = (bps) => `${(bps / 100).toFixed(1)}%`;

/** Description stored in the relay (the contract insists it starts with "Kairo relay "). The site shows the same words. */
export function relayDescription(coin, setName) {
  const c = COINS[coin];
  return setName === 'mainnet'
    ? `Kairo relay ${c.label}: Bitfinex last trade, checked against Chainlink within ${percent(c.bandBps)}`
    : `Kairo relay ${c.label} (TESTNET REHEARSAL): Bitfinex last trade, checked against a test stand-in within ${percent(c.bandBps)}`;
}

/** Description of the testnet stand-in for Chainlink (a MockPriceFeed, so it must start with the test warning). */
export const standInDescription = (coin) => `TEST PRICES - NOT REAL DATA / Chainlink stand-in ${COINS[coin].pair}`;

/** Every problem found in a set, as readable strings (empty = fine). Pure, so it can be tested. */
export function validateSet(setName) {
  const set = SETS[setName];
  const bad = [];
  if (!set) return [`unknown set ${setName}`];
  const names = new Set();
  for (const m of set.markets) {
    const n = COINS[m.coin] ? marketName(m) : `?${m.coin}`;
    if (!COINS[m.coin]) bad.push(`${n}: unknown coin`);
    if (names.has(n)) bad.push(`${n}: duplicate market name`);
    names.add(n);
    if (!(m.round >= 300)) bad.push(`${n}: round length must be at least 300 s`);
    if (!(m.offset >= 0 && m.offset < m.round)) bad.push(`${n}: offset must be below the round length`);
  }
  for (const round of new Set(set.markets.map((m) => m.round))) {
    const offsets = set.markets.filter((m) => m.round === round).map((m) => m.offset);
    if (new Set(offsets).size !== offsets.length) bad.push(`${round}s markets share a lock time`);
  }
  for (const c of Object.keys(COINS)) {
    if (!set.markets.some((m) => m.coin === c)) bad.push(`${c}: no market`);
    if (!(COINS[c].bandBps > 0 && COINS[c].bandBps <= 1000)) bad.push(`${c}: band outside 1..1000 bps`);
    if (!relayDescription(c, setName).startsWith('Kairo relay ')) bad.push(`${c}: relay description prefix`);
  }
  if (setName === 'mainnet') {
    for (const c of Object.keys(COINS)) if (!/^0x[0-9a-fA-F]{40}$/.test(CHAINLINK_MAINNET[c] || '')) bad.push(`${c}: no Chainlink proxy address`);
  }
  return bad;
}

/**
 * Is this on-chain feed a fit guard for this coin? Pure, so it can be tested.
 * feed = { description, decimals, answer (BigInt), updatedAt (seconds) }, now in seconds.
 * Returns the problems found (empty = fine). The same limits as the relay itself: positive answer, not older than 26 h, not in the future.
 */
export function judgeGuard(feed, coin, now) {
  const bad = [];
  if (feed.description !== COINS[coin].label) bad.push(`description is "${feed.description}", expected "${COINS[coin].label}"`);
  if (Number(feed.decimals) !== FEED_DECIMALS) bad.push(`decimals are ${feed.decimals}, expected ${FEED_DECIMALS}`);
  if (!(feed.answer > 0n)) bad.push(`latest answer is ${feed.answer}, expected above zero`);
  if (!(feed.updatedAt > 0)) bad.push('latest answer has no time');
  else if (feed.updatedAt > now) bad.push('latest answer is dated in the future');
  else if (now - feed.updatedAt > MAX_GUARD_AGE_SECONDS) bad.push(`latest answer is ${Math.round((now - feed.updatedAt) / 3600)} hours old, the relay accepts at most 26`);
  return bad;
}
