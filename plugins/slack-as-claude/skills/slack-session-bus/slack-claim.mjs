#!/usr/bin/env node
/**
 * Claim a task on the session bus, and find out whether you actually got it.
 *
 *   node slack-claim.mjs --channel C01234ABCDE --task 1788101338.332479 --session main
 *   → exit 0  you hold the claim, proceed
 *   → exit 1  someone else holds it, stand down
 *
 * WHY THIS EXISTS. §4's protocol is: post a claim, RE-READ THE THREAD, lowest ts wins,
 * losers stand down. Its soundness rests entirely on the re-read, and the re-read is a
 * discipline - which is to say it is the step that gets skipped. Posting a claim is not
 * winning a claim; a session that acts without re-reading has implemented a race with
 * extra steps. A rule asks for intention; a command asks for a keystroke.
 *
 * The exit code is the interface. "Did I win?" stops being a judgement call and becomes
 * a branch.
 *
 * ⛔ THIS IS NOT A LOCK. Slack assigns ts server-side, which gives a total order every
 * reader agrees on - that is what makes the winner deterministic. It is not mutual
 * exclusion, there is no lease, and nothing prevents a session from ignoring the result.
 * If double-execution would be destructive - a deploy, a migration, a payment - use
 * something with real leases instead.
 *
 * Node 18+. No dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPLIES = 'https://slack.com/api/conversations.replies';
const POST = 'https://slack.com/api/chat.postMessage';
const HISTORY = 'https://slack.com/api/conversations.history';
const STALE_AFTER = 2.5; // missed beats before a claimant counts as gone
// Absolute floor - see the note in slack-watch.mjs. A threshold proportional to the
// claimant's own declared rate punishes fast heartbeats, which are more evidence of life.
const STALE_FLOOR_SEC = 90;

function botToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'SLACK_BOT_TOKEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/SLACK_BOT_TOKEN\s+REG_(?:EXPAND_)?SZ\s+(\S+)/);
      if (m) return m[1];
    } catch {
      /* not there either */
    }
  }
  return null;
}

function ownPlugin() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = join(here, '..', '..', '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) return null;
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!m.version) return null;
    // +dev marks an authoring tree - see the note in slack-watch.mjs. This script is a
    // live example of why: it announced 2.4.1 while not existing in released 2.4.1.
    const dev = here.includes(join('.claude', 'plugins', 'cache')) ? '' : '+dev';
    return `${m.name || 'plugin'} ${m.version}${dev}`;
  } catch {
    return null;
  }
}

// Slack escapes &, < and > on the way in. Decode & LAST or "&amp;lt;" decodes twice.
const decode = (s) =>
  (s ?? '')
    .replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Read the identity off the CONTEXT BLOCK ELEMENTS, never by scanning the body text -
 *  a body parse cannot tell routing metadata from an English sentence about routing. */
function meta(msg) {
  const out = {};
  const ctx = (msg.blocks ?? []).find((b) => b.type === 'context');
  for (const el of ctx?.elements ?? []) {
    const m = (el.text ?? '').match(/^([a-z][a-z0-9_-]*):\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = decode(m[2]).replace(/^`|`$/g, '').trim();
  }
  return out;
}

const { values: a } = parseArgs({
  options: {
    channel: { type: 'string' },
    task: { type: 'string' },
    session: { type: 'string' },
    note: { type: 'string' },
    settle: { type: 'string', default: '2' },
    'ignore-stale': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const label = a.session || process.env.CLAUDE_SESSION_NAME || (process.env.CLAUDE_CODE_SESSION_ID ?? '').slice(0, 8);

if (a.help || !a.channel || !a.task || !label) {
  console.error(
    'usage: node slack-claim.mjs --channel <id> --task <ts> [--session <label>]\n' +
      '       [--note "..."] [--settle 2] [--ignore-stale] [--dry-run]\n' +
      '\n' +
      '  exit 0 = you hold the claim   exit 1 = you do not, stand down\n' +
      '\n' +
      '  --settle       seconds to wait before re-reading, covering read-after-write lag.\n' +
      '                 It is NOT a lock and does not make the claim exclusive.\n' +
      '  --ignore-stale treat a dead claimant as still holding the task.\n' +
      '\n' +
      '  QUOTE THE --task TIMESTAMP. A Slack ts has 16 significant digits; a shell that\n' +
      '  parses the bare token as a float rounds it, and Slack silently ignores it.',
  );
  process.exit(a.help ? 0 : 2);
}

if (!/^\d{10,}\.\d{6}$/.test(a.task)) {
  console.error(`--task "${a.task}" is not a Slack timestamp (expected 1234567890.123456). Quote it.`);
  process.exit(2);
}

const token = botToken();
if (!token) {
  console.error('SLACK_BOT_TOKEN is not set.');
  process.exit(2);
}

const auth = { Authorization: `Bearer ${token}` };
const jsonAuth = { ...auth, 'Content-Type': 'application/json; charset=utf-8' };

async function api(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetch(u, { headers: auth }).then((r) => r.json());
}

async function threadClaims() {
  const res = await api(REPLIES, { channel: a.channel, ts: a.task, limit: '200' });
  if (!res.ok) {
    console.error(`Could not read the task thread: ${res.error}`);
    process.exit(2);
  }
  return (res.messages ?? [])
    .filter((m) => m.ts !== a.task)
    .map((m) => ({ ts: m.ts, ...meta(m) }))
    .filter((m) => m.type === 'claim' && m.session);
}

async function resolutions() {
  // A done/fail in the thread ends the task: nothing to claim, and nothing to take over.
  const res = await api(REPLIES, { channel: a.channel, ts: a.task, limit: '200' });
  return (res.messages ?? [])
    .map((m) => ({ ts: m.ts, ...meta(m) }))
    .filter((m) => m.type === 'done' || m.type === 'fail');
}

/**
 * Has this session ANNOUNCED that it left? Returns the newest x-retired ts, or null.
 *
 * ★ This is the one POSITIVE signal of absence on the bus. Everything else - a stale
 * heartbeat, silence - is an inference, and inference costs a timeout. A session that
 * said it was leaving frees its claims IMMEDIATELY, because there is nothing to wait for.
 */
async function retirementOf(session) {
  const res = await api(HISTORY, { channel: a.channel, limit: '200' });
  if (!res.ok) return null;
  let newest = null;
  for (const m of res.messages ?? []) {
    const mm = meta(m);
    if (mm.type !== 'x-retired' || mm.session !== session) continue;
    if (!newest || Number(m.ts) > Number(newest.ts)) newest = { ts: m.ts, releases: mm.releases ?? '' };
  }
  return newest;
}

/** Liveness for one session, from its presence message. §6: an idle session is otherwise
 *  byte-identical to a dead one holding a claim. */
async function livenessOf(session) {
  const res = await api(HISTORY, { channel: a.channel, limit: '200' });
  if (!res.ok) return null;
  let best = null;
  for (const m of res.messages ?? []) {
    const mm = meta(m);
    if (mm.type !== 'x-presence' || mm.session !== session) continue;
    // Server-assigned beat: edited.ts if it has ever been refreshed, else the original.
    const beat = Number(m.edited?.ts ?? m.ts) || 0;
    if (!best || beat > best.beat) best = { beat, every: Number(mm.every) || 0 };
  }
  if (!best) return null;
  const age = Math.max(0, Math.floor(Date.now() / 1000 - best.beat));
  return { age, every: best.every, alive: age <= Math.max((best.every || 60) * STALE_AFTER, STALE_FLOOR_SEC) };
}

// --- decide -----------------------------------------------------------------

const done = await resolutions();
if (done.length) {
  const d = done[0];
  console.log(`ALREADY RESOLVED: ${d.session ?? '?'} posted type: ${d.type} at ${d.ts}.`);
  console.log('Nothing to claim. If this task needs redoing, announce it as a NEW task.');
  process.exit(1);
}

const before = await threadClaims();
const holder = before.slice().sort((x, y) => Number(x.ts) - Number(y.ts))[0] ?? null;

// Set when we decide a stale holder is abandoned. Its claim must then be excluded from
// the final ranking - otherwise the takeover is announced and immediately undone, because
// the abandoned claim still has the lowest ts and still wins.
let supersede = null;

if (holder && holder.session !== label) {
  // Retirement first: it is positive evidence, so it does not need a timeout. Only fall
  // back to the staleness judgement if the holder never said it was going.
  const retired = await retirementOf(holder.session);
  const retiredAfterClaim = retired && Number(retired.ts) > Number(holder.ts);

  const live = retiredAfterClaim ? null : await livenessOf(holder.session);
  if (retiredAfterClaim) {
    supersede = holder.session;
    takeoverReason = 'retired';
    takeoverEvidence = retired.ts;
    console.log(`${holder.session} held claim ${holder.ts} and RETIRED at ${retired.ts}.`);
    console.log('That is an announced departure, not a timeout: the claim is free immediately.');
  } else {
  const state = !live ? 'no presence published' : live.alive ? `alive, last beat ${live.age}s ago` : `STALE, last beat ${live.age}s ago`;
  if (live?.alive || a['ignore-stale'] || !live) {
    console.log(`HELD BY ${holder.session} (claim ${holder.ts}) - ${state}.`);
    if (!live) console.log('That session publishes no heartbeat, so its liveness is unknown. Treating the claim as held.');
    console.log('Stand down.');
    process.exit(1);
  }
  supersede = holder.session;
  console.log(`${holder.session} holds claim ${holder.ts} but is ${state}.`);
  console.log('Taking it over. This is a JUDGEMENT from a timeout, not proof that session is dead:');
    console.log('a wedged session behind a running watcher reads alive, and a live session whose');
    console.log('watcher died reads stale. Do not do this where double-execution is destructive.');
  }
}

if (a['dry-run']) {
  console.log(`DRY RUN - would claim task ${a.task} as "${label}".`);
  process.exit(0);
}

const note = a.note ? `\n\n${a.note}` : '';
const elements = [
  { type: 'mrkdwn', text: 'type: `claim`' },
  { type: 'mrkdwn', text: `session: \`${label}\`` },
];

// ⚠ A TAKEOVER MUST BE ANNOUNCED, because it is the point where readers can legitimately
// DISAGREE. Sorting by ts is deterministic; staleness is a clock-dependent predicate
// evaluated locally, so a reader checking before the timeout computes the old holder and
// one checking after computes the new one - same thread, same messages, different winner,
// no disagreement about any fact. Naming the superseded claim makes that divergence
// visible instead of silent.
//
// It stays `type: claim` deliberately: a distinct type would be excluded from the claim
// ranking and the takeover would not compete at all.
if (supersede) {
  const s = before.find((c) => c.session === supersede);
  elements.push({ type: 'mrkdwn', text: `supersedes: \`${s?.ts ?? supersede}\`` });
}
const plugin = ownPlugin();
if (plugin) elements.push({ type: 'mrkdwn', text: `plugin: \`${plugin}\`` });

const posted = await fetch(POST, {
  method: 'POST',
  headers: jsonAuth,
  body: JSON.stringify({
    channel: a.channel,
    thread_ts: a.task,
    // ⚠⚠ reply_broadcast IS LOAD-BEARING, NOT COSMETIC.
    //
    // conversations.history returns CHANNEL messages. A threaded reply is not in the
    // channel timeline, so a cursor poll structurally cannot see it - and §4 puts
    // claiming, done and fail IN THREADS while §5 makes the poller the delivery
    // mechanism. The consequence: a watching session sees tasks appear and NEVER sees
    // them resolved. Every announced task looks permanently open.
    //
    // Observed: a session claimed a task that had been completed thirteen seconds
    // earlier. Not carelessness - its instrument could not show thread activity at all.
    //
    // Broadcasting puts the claim in the channel timeline too, so a poller sees it,
    // while the thread stays the authoritative ordered record.
    reply_broadcast: true,
    text: `claim: ${label}`,
    blocks: [
      { type: 'context', elements },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: supersede
            ? `Claiming this task, superseding *${supersede}* whose heartbeat has gone stale. ` +
              'That is a judgement from a timeout, not proof it is dead - a reader evaluating ' +
              'before the timeout would still compute the earlier claim as the winner.' +
              note
            : `Claiming this task.${note}`,
        },
      },
    ],
  }),
}).then((r) => r.json());

if (!posted.ok) {
  console.error(`Could not post the claim: ${posted.error}`);
  process.exit(2);
}

// Settle before re-reading. This covers READ-AFTER-WRITE lag - a claim that landed a
// moment before yours may not be visible yet, and two sessions could each see only their
// own and both declare victory. It is not a lock and it does not make the claim
// exclusive; it just makes the read more likely to be complete.
const settle = Math.max(0, Number(a.settle) || 0);
if (settle) await new Promise((r) => setTimeout(r, settle * 1000));

const after = await threadClaims();
// A superseded claim is shown but does not compete. Without this the takeover branch
// announces itself and then loses to the very claim it just declared abandoned.
const ranked = after
  .filter((c) => c.session !== supersede)
  .sort((x, y) => Number(x.ts) - Number(y.ts) || (x.session < y.session ? -1 : 1));
const winner = ranked[0];

console.log(`Claims in thread (${after.length}):`);
for (const c of after.slice().sort((x, y) => Number(x.ts) - Number(y.ts))) {
  const mark = c.session === supersede ? '  <- superseded, stale' : c.session === label ? '  <- you' : '';
  console.log(`  ${c.ts}  ${c.session}${mark}`);
}

if (!winner) {
  console.error('\nNo claims visible after posting - the read is incomplete. Do NOT proceed.');
  process.exit(1);
}

if (winner.session === label) {
  console.log(`\nYOU HOLD IT. Lowest ts is yours (${winner.ts}).`);
  console.log('Post type: done (or fail) into this thread when finished, and heartbeat while you work.');
  process.exit(0);
}

console.log(`\nSTAND DOWN. ${winner.session} holds it with the lower ts (${winner.ts}).`);
console.log('Your claim stays in the thread as a record; it is not an error to have lost.');
process.exit(1);
