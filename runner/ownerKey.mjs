// Is the mainnet OWNER key in a settings file? (audit part 2, P2-03)
//
// The owner key can hand price control to anyone (docs/RUNBOOK.md, section 1), so a LIVE mainnet runner refuses to start next
// to it, and the server setup is not READY while it is there. This module only answers yes or no: it looks at the name and at
// whether the value is empty, and never keeps, returns or prints the value. It lives on its own so that the mainnet runner's
// files (runner/mainnet.mjs, runner/run-mainnet.mjs) never contain the owner key's name at all (a test checks that).
export const OWNER_KEY_NAME = 'MAINNET_DEPLOYER_PRIVATE_KEY';

/** true when the text has a line giving OWNER_KEY_NAME a non-empty value (an empty placeholder or a comment does not count). */
export function holdsOwnerKey(text) {
  return new RegExp(`^[ \\t]*${OWNER_KEY_NAME}[ \\t]*=[ \\t]*\\S`, 'm').test(String(text));
}
