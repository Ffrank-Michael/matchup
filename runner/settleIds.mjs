// Works out which two price-update ids to hand to settle(), using the same rules as the contract:
//   START = the first update with updatedAt >= lock
//   END   = the last update with updatedAt <= end
// `updates` is the feed history, oldest first: [{ id: <BigInt>, updatedAt: <seconds> }, ...]
// The contract double-checks both ids itself; this only has to find the right ones.
export function findSettleIds(updates, lock, end) {
  const start = updates.find((u) => u.updatedAt >= lock);
  if (!start) return { startId: 0n, endId: 0n }; // 0 means "no update since lock": a refund
  let endUpdate;
  for (const u of updates) if (u.updatedAt <= end) endUpdate = u;
  return { startId: start.id, endId: endUpdate ? endUpdate.id : 0n };
}
