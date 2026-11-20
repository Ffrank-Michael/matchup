// "Continue with Google": the browser's only way to Circle's wallet API. The Circle API key is read here, on the server, and is
// never sent back. Only the four actions in lib/circle-api.ts are accepted (sign-in and wallet only; nothing that moves money).
import { describeFailure, runCircleAction } from "@/lib/circle-api";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  const { status, body } = await runCircleAction(input, { apiKey: process.env.CIRCLE_API_KEY ?? "" });
  // A failure is written to the server log with Circle's own code and message (the key is already cut out of the message)
  if (status >= 400) console.warn(describeFailure(input, status, body));
  return Response.json(body, { status, headers: NO_STORE });
}
