// Made-up test prices: a gentle random walk (each step moves the price by up to +/-0.4%).
// Returned prices are integers with 8 decimals (BigInt), the format the mock feed stores.
import { FEED_DECIMALS } from './config.mjs';

export function createWalk(startUsd, random = Math.random) {
  let price = startUsd;
  return {
    next() {
      price = Math.max(0.01, price * (1 + (random() * 2 - 1) * 0.004));
      return BigInt(Math.round(price * 10 ** FEED_DECIMALS));
    },
  };
}
