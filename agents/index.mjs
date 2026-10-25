// The four house agents, in the order they act.
import * as trendFollower from './trendFollower.mjs';
import * as contrarian from './contrarian.mjs';
import * as streakHunter from './streakHunter.mjs';
import * as coinFlipper from './coinFlipper.mjs';

export const agents = [trendFollower, contrarian, streakHunter, coinFlipper];
