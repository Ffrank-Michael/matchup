// The agents' GUIDE CALLS: UP or DOWN calls the four agents make on every round whether or not anyone plays. No money moves and
// nothing is sent on chain. The mainnet runner writes them (runner/guide.mjs) to one Upstash hash, "kairo:guide" (free tier);
// this route reads them for the site. On a developer's PC without Upstash settings it reads the runner's local file instead.
//   field "<market>:<round>:<agent>"  the call: { c: UP|DOWN|null, t: reason, at: time made, s: called|skipped, src: ai|random }
//   field "<market>:<round>:res"      how the round ended: { res: UP|DOWN|FLAT } (a call wins when it matches; FLAT is no result)
// One Upstash command (HMGET) answers a request, and the answer is kept for 20 seconds per market and round, so a crowd of
// visitors costs the same as one. Only the fields below leave this route, checked one by one.
import fs from "node:fs";
import path from "node:path";

const AGENTS = ["trend-follower", "contrarian", "chart-reader", "coin-flipper"] as const;
type Agent = (typeof AGENTS)[number];
const HASH = "kairo:guide";
const HISTORY = 40; // earlier rounds of the market that count for the win rate and the last five calls
const MAX_TEXT = 200;
const CACHE_MS = 20_000;
const NO_STORE = { "cache-control": "no-store" };

type Call = { c: "UP" | "DOWN" | null; t: string; at: number; s: "called" | "skipped"; src: "ai" | "random" };
type Past = { r: number; c: "UP" | "DOWN"; at: number; res: "won" | "lost" | "none" | "pending" };
type Answer = { agents: Record<Agent, { current: Call | null; recent: Past[]; wins: number; decided: number }> };

const parse = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== "string") return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Keeps a stored call only if every field has the expected shape; the text is trimmed and shortened. */
function cleanCall(raw: Record<string, unknown> | null): Call | null {
  if (!raw) return null;
  if (raw.s !== "called" && raw.s !== "skipped") return null;
  const c = raw.c === "UP" || raw.c === "DOWN" ? raw.c : null;
  if (raw.s === "called" && !c) return null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? Math.floor(raw.at) : 0;
  const t = typeof raw.t === "string" ? raw.t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
  if (!at || !t) return null;
  return { c: raw.s === "called" ? c : null, t, at, s: raw.s, src: raw.src === "random" ? "random" : "ai" };
}

const fieldsFor = (market: number, round: number): string[] => {
  const out: string[] = [];
  for (const a of AGENTS) out.push(`${market}:${round}:${a}`);
  for (let r = round - 1; r >= Math.max(0, round - HISTORY); r--) {
    for (const a of AGENTS) out.push(`${market}:${r}:${a}`);
    out.push(`${market}:${r}:res`);
  }
  return out;
};

async function fromUpstash(url: string, token: string, fields: string[]): Promise<(string | null)[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(["HMGET", HASH, ...fields]),
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  const list = Array.isArray(body.result) ? body.result : [];
  return fields.map((_, i) => (typeof list[i] === "string" ? (list[i] as string) : null));
}

/** The runner's local file (a developer's PC): the same fields, later lines win. */
function fromLocalFile(fields: string[]): (string | null)[] {
  const map = new Map<string, string>();
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), "..", "data", "guide-calls-mainnet.jsonl"), "utf8");
    for (const line of text.split("\n").slice(-20000)) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; /* a half-written last line */ }
      if (e.type === "score") map.set(`${e.m}:${e.r}:res`, JSON.stringify({ res: e.res }));
      else if (typeof e.a === "string" && !map.has(`${e.m}:${e.r}:${e.a}`)) map.set(`${e.m}:${e.r}:${e.a}`, JSON.stringify({ c: e.c, t: e.t, at: e.at, s: e.s, src: e.src })); // a call is never changed: the first one stays
    }
  } catch { /* no file yet */ }
  return fields.map((f) => map.get(f) ?? null);
}

function build(market: number, round: number, fields: string[], values: (string | null)[]): Answer {
  const byField = new Map(fields.map((f, i) => [f, values[i]]));
  const agents = {} as Answer["agents"];
  for (const a of AGENTS) {
    const current = cleanCall(parse(byField.get(`${market}:${round}:${a}`) ?? null));
    const recent: Past[] = [];
    let wins = 0, decided = 0;
    for (let r = round - 1; r >= Math.max(0, round - HISTORY); r--) {
      const call = cleanCall(parse(byField.get(`${market}:${r}:${a}`) ?? null));
      if (!call || call.s !== "called" || !call.c) continue; // "Couldn't decide" is not a call
      const outcome = parse(byField.get(`${market}:${r}:res`) ?? null)?.res;
      const res: Past["res"] = outcome === "UP" || outcome === "DOWN" ? (outcome === call.c ? "won" : "lost") : outcome === "FLAT" ? "none" : "pending";
      if (res === "won") { wins++; decided++; } else if (res === "lost") decided++;
      if (recent.length < 5) recent.push({ r, c: call.c, at: call.at, res });
    }
    agents[a] = { current, recent, wins, decided };
  }
  return { agents };
}

const cache = new Map<string, { at: number; answer: Answer }>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const market = Number(searchParams.get("market"));
  const round = Number(searchParams.get("round"));
  if (!Number.isInteger(market) || market < 0 || market > 1000 || !Number.isInteger(round) || round < 0) {
    return Response.json({ error: "bad request" }, { status: 400, headers: NO_STORE });
  }
  const key = `${market}:${round}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Response.json(hit.answer, { headers: NO_STORE });

  const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
  const fields = fieldsFor(market, round);
  try {
    const values = url && token ? await fromUpstash(url, token, fields) : fromLocalFile(fields);
    const answer = build(market, round, fields, values);
    if (cache.size > 200) cache.clear();
    cache.set(key, { at: Date.now(), answer });
    return Response.json(answer, { headers: NO_STORE });
  } catch {
    return Response.json(hit?.answer ?? build(market, round, [], []), { headers: NO_STORE });
  }
}
