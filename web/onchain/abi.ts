/**
 * src/onchain/abi.ts
 * ─────────────────────────────────────────────────────────────
 * ABI for PredictionArena and a minimal ERC-20.
 * Copied from the compiled Foundry output (contracts/out/PredictionArena.sol/PredictionArena.json).
 * Only the view/pure functions needed by the read hooks are included plus the
 * events/errors that wagmi needs for type inference.
 */

// ── PredictionArena ──────────────────────────────────────────

export const ARENA_ABI = [
  // ── constants / immutables ──────────────────────────────────
  { type: "function", name: "BPS", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "FEE_BPS", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "SETTLE_WINDOW", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "USDC", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  // ── market reads ───────────────────────────────────────────
  { type: "function", name: "marketCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function", name: "markets",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      { name: "feedA",       type: "address" },
      { name: "feedB",       type: "address" },
      { name: "roundLength", type: "uint32" },
      { name: "startOffset", type: "uint32" },
      { name: "minStake",    type: "uint128" },
      { name: "paused",      type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "marketName",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "nextCallableRound",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "lockTime",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "roundIndex", type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "endTime",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "roundIndex", type: "uint256" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  // ── round reads ────────────────────────────────────────────
  {
    type: "function", name: "rounds",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "roundIndex", type: "uint256" }],
    outputs: [
      { name: "upTotal",    type: "uint128" },
      { name: "downTotal",  type: "uint128" },
      { name: "startRoundId", type: "uint80" },
      { name: "endRoundId",   type: "uint80" },
      { name: "startPrice", type: "int256" },
      { name: "endPrice",   type: "int256" },
      { name: "state",      type: "uint8" },   // RoundState enum: 0=Unsettled 1=SettledUp 2=SettledDown 3=Refunded
    ],
    stateMutability: "view",
  },
  // ── position reads ─────────────────────────────────────────
  {
    type: "function", name: "positions",
    inputs: [
      { name: "marketId",   type: "uint256" },
      { name: "roundIndex", type: "uint256" },
      { name: "player",     type: "address" },
    ],
    outputs: [
      { name: "up",      type: "uint128" },
      { name: "down",    type: "uint128" },
      { name: "claimed", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function", name: "claimable",
    inputs: [
      { name: "marketId",   type: "uint256" },
      { name: "roundIndex", type: "uint256" },
      { name: "player",     type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  // ── payout progress (dust tracking) ───────────────────────
  {
    type: "function", name: "payoutProgress",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "roundIndex", type: "uint256" }],
    outputs: [
      { name: "winnerStakeClaimed", type: "uint128" },
      { name: "bonusPaid",          type: "uint128" },
    ],
    stateMutability: "view",
  },
  // ── fee state ──────────────────────────────────────────────
  {
    type: "function", name: "feesAccrued",
    inputs: [], outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "totalPlayerFunds",
    inputs: [], outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  // ── write functions (for T3; included so wagmi has the full type) ──
  {
    type: "function", name: "placeCall",
    inputs: [
      { name: "marketId",   type: "uint256" },
      { name: "roundIndex", type: "uint256" },
      { name: "up",         type: "bool" },
      { name: "amount",     type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "claim",
    inputs: [{ name: "marketId", type: "uint256" }, { name: "roundIndex", type: "uint256" }],
    outputs: [{ name: "payout", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "claimMany",
    inputs: [
      { name: "marketIds",    type: "uint256[]" },
      { name: "roundIndexes", type: "uint256[]" },
    ],
    outputs: [{ name: "totalPayout", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // ── events ─────────────────────────────────────────────────
  {
    type: "event", name: "CallPlaced",
    inputs: [
      { name: "marketId",   type: "uint256", indexed: true },
      { name: "roundIndex", type: "uint256", indexed: true },
      { name: "player",     type: "address", indexed: true },
      { name: "up",         type: "bool",    indexed: false },
      { name: "amount",     type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Claimed",
    inputs: [
      { name: "marketId",   type: "uint256", indexed: true },
      { name: "roundIndex", type: "uint256", indexed: true },
      { name: "player",     type: "address", indexed: true },
      { name: "amount",     type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "MarketCreated",
    inputs: [
      { name: "marketId",    type: "uint256", indexed: true },
      { name: "name",        type: "string",  indexed: false },
      { name: "feedA",       type: "address", indexed: true },
      { name: "feedB",       type: "address", indexed: false },
      { name: "roundLength", type: "uint32",  indexed: false },
      { name: "startOffset", type: "uint32",  indexed: false },
      { name: "minStake",    type: "uint128", indexed: false },
    ],
  },
] as const;

// ── Minimal ERC-20 ───────────────────────────────────────────
// balanceOf, allowance, approve — all that the app needs for USDC display and approve flow.

export const ERC20_ABI = [
  {
    type: "function", name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "allowance",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function", name: "approve",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event", name: "Transfer",
    inputs: [
      { name: "from",  type: "address", indexed: true },
      { name: "to",    type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Approval",
    inputs: [
      { name: "owner",   type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value",   type: "uint256", indexed: false },
    ],
  },
] as const;
