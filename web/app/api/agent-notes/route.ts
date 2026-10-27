// The one-sentence reasons the three AI agents (Trend Follower, Contrarian, Chart Reader) gave for their calls, or
// "Couldn't decide this round" when the AI failed. The runner writes them (runner/notes.mjs) to Upstash Redis (free);
// this route reads them for the site. On a developer's PC without Upstash settings it reads the runner's local file instead.
// Only these fields leave this route, checked one by one: the round, the agent, called or skipped, UP or DOWN, and the text.
import fs from "node:fs";
import path from "node:path";

const AGENTS = new Set(["trend-follower", "contrarian", "chart-reader"]);
const MAX_ROUNDS = 8;
const MAX_TEXT = 200;
const NO_STORE = { "cache-control": "no-store" };

type Note = { r: number; a: string; s: "called" | "skipped"; c: "UP" | "DOWN" | null; t: string };

/** Keeps a stored note only if every field has the expected shape; the text is trimmed and shortened. */
function clean(raw: unknown, market: number, rounds: Set<number>): Note | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (n.m !== market || typeof n.r !== "number" || !rounds.has(n.r)) return null;
  if (typeof n.a !== "string" || !AGENTS.has(n.a)) return null;
  if (n.s !== "called" && n.s !== "skipped") return null;
  const c = n.c === "UP" || n.c === "DOWN" ? n.c : null;
  if (n.s === "called" && !c) return null;
  const t = typeof n.t === "string" ? n.t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
  if (!t) return null;
  return { r: n.r, a: n.a, s: n.s, c: n.s === "called" ? c : null, t };
}

async function fromUpstash(url: string, token: string, market: number, rounds: number[]): Promise<unknown[]> {
  const keys = rounds.flatMap((r) => [...AGENTS].map((a) => `kairo:note:${market}:${r}:${a}`));
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(["MGET", ...keys]),
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  const list = Array.isArray(body.result) ? body.result : [];
  return list.map((v) => {
    if (typeof v !== "string") return null;
    try { return JSON.parse(v); } catch { return null; }
  });
}

function fromLocalFile(): unknown[] {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), "..", "data", "agent-notes.jsonl"), "utf8");
    const out: unknown[] = [];
    for (const line of text.split("\n").slice(-2000)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a half-written last line */ }
    }
    return out; // later lines win below
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const market = Number(searchParams.get("market"));
  const rounds = (searchParams.get("rounds") ?? "").split(",").map(Number).filter((r) => Number.isInteger(r) && r >= 0);
  if (!Number.isInteger(market) || market < 0 || rounds.length === 0 || rounds.length > MAX_ROUNDS) {
    return Response.json({ error: "bad request" }, { status: 400, headers: NO_STORE });
  }
  const wanted = new Set(rounds);
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
  try {
    const raw = url && token ? await fromUpstash(url.replace(/\/+$/, ""), token, market, rounds) : fromLocalFile();
    const byKey = new Map<string, Note>();
    for (const item of raw) {
      const note = clean(item, market, wanted);
      if (note) byKey.set(`${note.r}:${note.a}`, note);
    }
    return Response.json({ notes: [...byKey.values()] }, { headers: NO_STORE });
  } catch {
    return Response.json({ notes: [] }, { headers: NO_STORE });
  }
}
