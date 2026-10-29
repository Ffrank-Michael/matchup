// The deploy script's saved state, and what happens to an older deployment file before a new deployment starts.
//
// deployments/arc-mainnet.json holds the first contract set ("v1": PredictionArena with placeBet, relays labelled "Kairo relay").
// The renamed contracts ("v2": placeCall, relays labelled "Matchup relay") are a NEW deployment. The deploy script is safe to re-run
// (finished steps are skipped), so it must never mistake the v1 file for a half-finished v2 deployment and carry on with the old
// addresses. A state file that does not say contractVersion 2 is therefore copied to arc-mainnet-v1.json first, and a fresh state starts.
import fs from 'node:fs';
import path from 'node:path';

export const CONTRACT_VERSION = 2;

/**
 * Looks at the saved state file. Returns { state, archived }:
 *   - no file                         -> { state: null, archived: null }
 *   - file says contractVersion 2     -> { state: <the file>, archived: null }   (a v2 deployment in progress: carry on)
 *   - any other file (the v1 set)     -> copied to archiveFile, then { state: null, archived: archiveFile }
 * The copy is never written over an existing archive: if archiveFile already exists and differs, it throws and changes nothing.
 */
export function loadOrArchiveState(stateFile, archiveFile) {
  if (!fs.existsSync(stateFile)) return { state: null, archived: null };
  const text = fs.readFileSync(stateFile, 'utf8');
  const state = JSON.parse(text);
  if (state.contractVersion === CONTRACT_VERSION) return { state, archived: null };
  if (fs.existsSync(archiveFile) && fs.readFileSync(archiveFile, 'utf8') !== text) {
    throw new Error(`${path.basename(archiveFile)} already exists and is different from ${path.basename(stateFile)}. Move one of them away by hand; nothing was changed.`);
  }
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  fs.writeFileSync(archiveFile, text);
  return { state: null, archived: archiveFile };
}

/** The state file that would be archived (read only, for the dry-run plan): the file's name, or null when there is nothing to archive. */
export function wouldArchive(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, 'utf8')).contractVersion === CONTRACT_VERSION ? null : path.basename(stateFile);
}
