// The four house agents, in the order they act.
import * as trendFollower from './trendFollower.mjs';
import * as contrarian from './contrarian.mjs';
import * as chartReader from './chartReader.mjs';
import * as coinFlipper from './coinFlipper.mjs';

export const agents = [trendFollower, contrarian, chartReader, coinFlipper];

// wallet key -> agent, and the public name shown in logs ("Agent 1 · Trend Follower")
export const BY_KEY = {
  'trend-follower': trendFollower,
  contrarian,
  'chart-reader': chartReader,
  'coin-flipper': coinFlipper,
};
export const displayName = (key) => BY_KEY[key]?.name ?? key;
