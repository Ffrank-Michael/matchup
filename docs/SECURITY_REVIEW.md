# Internal security review (not an audit)

Date: 31 Oct 2026. Scope: `contracts/PredictionArena.sol` and `contracts/GuardedRelayFeed.sol` at commit `f3b5cdb` (the code deployed to Arc mainnet as v2).
Method: a read-through of the code by an AI assistant (Claude), written down in plain words. The Foundry test suite was not re-run for this review; it was relied on as it stood (301 tests in Arc Studio, and the repo's CI).

**This is not an audit and not a guarantee.** Nobody independent has reviewed these contracts. Use small amounts.

## What was checked, and what was found OK

- **Player money cannot be reached by the owner.** The only way USDC leaves the contract is a player's own `claim` / `claimMany`, or `withdrawFees`, which is capped at `feesAccrued` and also checks that the contract keeps at least `totalPlayerFunds`.
- **Reentrancy.** `placeCall`, `settle`, `claim`, `claimMany` and `withdrawFees` are `nonReentrant`. Claims set `claimed` and lower `totalPlayerFunds` before the transfer.
- **Calls.** Only the next round can be called, below the lock; the stake must be at least the market minimum; one side per wallet per round; amounts above `uint128` revert.
- **Settling is permissionless but not steerable.** The caller supplies the feed round IDs, and the contract checks them: the start must be the first update at or after the lock, the end must be the last update at or before the round end. A one-sided round is refunded without looking at prices.
- **Refunds.** One-sided, unchanged price, no usable update, phase edge, bad price and a 1 hour timeout all refund the full stake with no fee. After the timeout, `claim` finishes the refund by itself, so nobody needs a helper.
- **Owner powers are small.** Create markets, pause a market (claims and settling still work while paused), withdraw fees, and move ownership in two steps. `renounceOwnership` is disabled. The fee is a constant (2% of the matched pool).
- **Relay price checks.** Prices must be positive, the Chainlink reference must be fresh (up to 26 hours), and the pushed price must be inside the band (1.0% BTC, 1.5% ETH and SOL). Each price is stamped with the block time.

## Findings

1. **Medium, by design: the runner chooses the price inside the band.** The relay trusts one pusher wallet. Within 1.0% to 1.5% of Chainlink's latest price it can post any price. Short rounds (5m, 10m) usually move less than that, so a dishonest or hacked runner could decide their results. It cannot take the pot any other way. The runner wallet holds only a few USDC. The owner can replace it with `setPusher`. Disclosed in the README. Fix later: a narrower band, several price sources, or settling straight from Chainlink.
2. **Low: the reference price can be old.** The Chainlink reference may be up to 26 hours old. The band is measured from that value, so on a quiet feed the band can sit away from the live market.
3. **Low: the pusher can force refunds.** By not posting a start or an end price, the runner can turn a round into a refund. This cannot cost players money, only the chance to win.
4. **Low: a few micro-USDC of rounding dust may stay in the contract.** In some bigger-side-loser cases, a caller whose unmatched part is zero reverts before the dust tracker counts them, so that dust is not moved to fees. No player is shorted and `totalPlayerFunds` stays on the safe side.
5. **Info: the owner picks the markets.** `createMarket` accepts any feed address, so a market is only as honest as its feed. The three live markets use the three relays listed in the README.
6. **Info: the contract has naming history.** v1 (retired) used `placeBet`; v2 uses `placeCall`. Some code comments still mention an early build plan and testnet.

## Not covered

No fuzzing or formal checks were run in this review. The USDC token itself (Arc's system token) and the Chainlink feeds on Arc were assumed to behave as documented. The website, runner and server were not reviewed for security here, apart from a scan of the repository and its full git history for leaked keys, which was clean.
