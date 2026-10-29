// Keeps the round runner alive: starts `node runner/run.mjs --live`, and when it stops for any reason starts it again after a
// short wait, posting one plain line to ntfy.sh (a free phone push) each time. Nothing secret is ever sent: only a line like
// "Matchup runner stopped (exit 1), restarting in 15 s".
//
//   node runner/supervise.mjs                 supervise the testnet runner (output goes to data/runner.log)
//   node runner/supervise.mjs --journal       the same, but everything goes to stdout (a systemd service: read it with journalctl)
//   node runner/supervise.mjs --mainnet       supervise the MAINNET runner (runner/run-mainnet.mjs) as a dry run that sends nothing; log in data/runner-mainnet.log
//   node runner/supervise.mjs --mainnet --i-understand-this-spends-real-usdc
//                                             the same, but the mainnet runner really sends (real USDC). The flag is passed on to it, never added by default.
//
// The ntfy topic is read from NTFY_TOPIC in .env (you choose it; anyone who knows the topic name can read it, so pick a long
// random one). With no topic the supervisor still restarts the runner and only logs.
// It does not hide a crash loop: after 5 stops within 10 minutes it waits 5 minutes between tries and says so.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_DELAY_S = 15;
export const LOOP_STOPS = 5;        // this many stops ...
export const LOOP_WINDOW_S = 600;   // ... inside this many seconds is a crash loop
export const LOOP_DELAY_S = 300;    // and then the wait between tries is this long

/** How long to wait before starting again, given when the runner stopped before (unix seconds, newest last, including this stop). */
export function restartDelay(stops, now) {
  const recent = stops.filter((t) => now - t <= LOOP_WINDOW_S);
  return recent.length >= LOOP_STOPS ? { seconds: LOOP_DELAY_S, loop: true } : { seconds: BASE_DELAY_S, loop: false };
}

/** What to supervise: the testnet runner (--live), or with --mainnet the mainnet runner, which sends only when the supervisor was given the same long flag. */
export function runnerSpec(argv) {
  if (!argv.includes('--mainnet')) return { script: 'runner/run.mjs', args: ['--live'], name: 'testnet', title: 'Matchup runner', logName: 'runner.log' };
  const live = argv.includes('--i-understand-this-spends-real-usdc');
  return { script: 'runner/run-mainnet.mjs', args: live ? ['--i-understand-this-spends-real-usdc'] : [], name: live ? 'MAINNET (live)' : 'mainnet (dry run)', title: 'Matchup MAINNET runner', logName: 'runner-mainnet.log' };
}

/** One plain line to ntfy.sh. Never throws: an alert that cannot be sent must not stop the supervisor. */
export async function notify(topic, title, message, fetchFn = fetch) {
  if (!topic) return false;
  try {
    const res = await fetchFn(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body: message, headers: { Title: title, Priority: 'high', Tags: 'warning' }, signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

function readTopic(root) {
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*NTFY_TOPIC\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1];
    }
  } catch { /* no .env: no alerts */ }
  return '';
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const topic = readTopic(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const spec = runnerSpec(process.argv.slice(2));
  const logFile = path.join(root, 'data', spec.logName);
  const journal = process.argv.includes('--journal'); // under systemd stdout is the log (journald adds the dates), so no file
  const say = (m) => { const line = `${new Date().toISOString().slice(11, 19)}  [supervisor] ${m}\n`; if (!journal) fs.appendFileSync(logFile, line); process.stdout.write(line); };
  say(`started for the ${spec.name} runner; alerts ${topic ? 'on (ntfy)' : 'OFF: add NTFY_TOPIC to .env'}`);
  const stops = [];
  for (;;) {
    const out = journal ? 'inherit' : fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [spec.script, ...spec.args], { cwd: root, stdio: ['ignore', out, out] });
    say(`runner started (pid ${child.pid})`);
    const code = await new Promise((resolve) => { child.on('exit', (c, s) => resolve(c ?? s)); child.on('error', () => resolve('spawn error')); });
    if (!journal) fs.closeSync(out);
    const now = Math.floor(Date.now() / 1000);
    stops.push(now);
    const { seconds, loop } = restartDelay(stops, now);
    say(`runner stopped (${code}); restarting in ${seconds} s${loop ? ' (crash loop)' : ''}`);
    await notify(topic, loop ? `${spec.title} crash loop` : `${spec.title} stopped`, `The ${spec.name} runner stopped (${code}). Restarting in ${seconds} s${loop ? `; it keeps stopping, please look at ${journal ? 'journalctl -u kairo-runner' : 'data/' + spec.logName}` : ''}.`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await notify(topic, `${spec.title} restarted`, `The ${spec.name} runner is running again.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('supervise.mjs')) await main();
