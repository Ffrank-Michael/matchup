// "Continue with Google": the browser's only way to Circle's wallet API. The Circle API key is read here, on the server, and is
// never sent back. Only the actions in lib/circle-api.ts are accepted: sign-in, wallet, withdrawing USDC on Arc, and the two
// Matchup contract calls (approve USDC for the arena, placeCall), each approved by the player on Circle's confirmation screen.
// Tokens are never logged (see describeFailure).
import deployment from "@/lib/deployment.generated.json";
import { describeFailure, runCircleAction } from "@/lib/circle-api";

const NO_STORE = { "cache-control": "no-store" };

// The Google wallet lives on Arc mainnet, so contract calls go only to the mainnet arena: when the site is built for testnet
// (deployment chain 5042002) there is no arena for them and the server refuses them.
const MAINNET = deployment.chainId === 5042;
const ARENA = MAINNET ? deployment.arena : null;
const MARKET_IDS = MAINNET ? deployment.markets.map((m) => m.id) : [];

export async function POST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  const { status, body } = await runCircleAction(input, { apiKey: process.env.CIRCLE_API_KEY ?? "", arena: ARENA, marketIds: MARKET_IDS });
  // A failure is written to the server log with Circle's own code and message (the key is already cut out of the message)
  if (status >= 400) console.warn(describeFailure(input, status, body));
  return Response.json(body, { status, headers: NO_STORE });
}
