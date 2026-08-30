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

/**
 * ⛔⛔ EXIT 1 IS A VERDICT. AN ERROR MUST NEVER USE IT.
 *
 * This tool's whole contract is "the exit code is the answer": 0 = you hold the claim,
 * 1 = stand down. An uncaught exception ALSO exits 1 - so a crash was indistinguishable
 * from a legitimate loss, and a caller doing `slack-claim ... || stand_down` would stand
 * down on a crash and never learn there had been one.
 *
 * ★ And it failed in the WRONG DIRECTION. The case that crashed was the RETIREMENT
 * fast-path - precisely when the claim IS free and the correct action is TAKE IT. The
 * crash converted "take it" into "stand down", silently, in the one branch where
 * standing down is wrong. A tool that fails safe would have exited 2.
 */
process.on('uncaughtException', (e) => {
  console.error(`ERROR (not a verdict): ${e?.stack ?? e}`);
  console.error('Exit 2 = something broke. Exit 1 would have meant "you lost the claim", which');
  console.error('is a different statement and would have been a lie.');
  process.exit(2);
});
process.on('unhandledRejection', (e) => {
  console.error(`ERROR (not a verdict): ${e?.stack ?? e}`);
  process.exit(2);
});

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

// --- ranking ----------------------------------------------------------------
// THE ONE PLACE THE WINNER IS DECIDED. Three sites used to sort inline and two of
// them omitted the tiebreak, so "who holds it" and "who is DISPLAYED as holding
// it" were computed by different rules. They are one rule now.
//
// ⚠ ts IS COMPARED AS A STRING, DELIBERATELY. Do not "fix" this to Number().
// A Slack ts is fixed-width - 10 integer digits and 6 zero-padded decimals - so
// lexical order IS numeric order, exactly, with no float anywhere in the path.
// Number() happens to work today with 4.19x headroom - an IEEE double's ULP at
// 1.79e9 is 2.384e-7 against a 1e-6 tick - and the headroom halves at each binade
// boundary as the epoch grows:
//
//     today  1.79e9   ULP 2.384e-7   headroom 4.19x
//     2106   4.29e9   ULP 4.768e-7   headroom 2.10x
//     2242   8.59e9   ULP 1.907e-6   headroom 0.52x   <- ordering ACTUALLY BREAKS
//
// So Number() is not close to failing; it fails in 2242, not 2106. Kept as string
// comparison anyway, because the argument was never "it is about to break" - it is
// that a fixed-width decimal string compares EXACTLY, for free, with no binade to
// reason about at all. Same class as the unquoted --thread-ts a shell rounds to a
// float: a ts is an IDENTIFIER that looks like a number, and every conversion to a
// number is a chance to lose the low digits that are the only thing making it
// unique. Do not "fix" this back to Number().
function rankClaims(claims, { exclude = null } = {}) {
  return claims
    .filter((c) => c.session !== exclude)
    .slice()
    .sort((x, y) =>
      x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.session < y.session ? -1 : x.session > y.session ? 1 : 0,
    );
}

// Equal ts is UNREACHABLE THROUGH SLACK: the server assigns a distinct ts per
// channel message, which is the entire reason this protocol is a sort and not a
// lock. So the tiebreak never executes in production - and a branch that never
// runs is indistinguishable from a broken one. This feeds rankClaims() the input
// the transport cannot produce, so the branch is exercised on demand instead of
// being carried untested forever or dropped and silently becoming arbitrary.
function selfTest() {
  let failed = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  };
  const s = (ts, session) => ({ ts, session });
  const names = (r) => r.map((c) => c.session);

  check('earlier ts wins',
    names(rankClaims([s('1788113122.246560', 'aaa'), s('1788113122.246559', 'zzz')])), ['zzz', 'aaa']);
  check('EQUAL ts -> lexical session decides (the branch Slack cannot reach)',
    names(rankClaims([s('1788113122.246559', 'zebra'), s('1788113122.246559', 'alpha')])), ['alpha', 'zebra']);
  check('ts outranks the name - a low name does not win from a later ts',
    names(rankClaims([s('1788113122.246559', 'zzz'), s('1788113122.999999', 'aaa')])), ['zzz', 'aaa']);
  check('exclude drops a superseded claim out of the ranking',
    names(rankClaims([s('1788113122.000001', 'gone'), s('1788113122.000002', 'live')], { exclude: 'gone' })), ['live']);
  check('adjacent-microsecond ts stay ordered (float has 4.19x headroom here)',
    names(rankClaims([s('1788113122.246560', 'later'), s('1788113122.246559', 'earlier')])), ['earlier', 'later']);
  check('ts past double precision still orders (2242-era: float headroom 0.52x)',
    names(rankClaims([s('9999999999.999999', 'later'), s('9999999999.999998', 'earlier')])), ['earlier', 'later']);
  check('total order - every permutation of one set yields one winner',
    [...new Set([
      [s('3.000000', 'c'), s('1.000000', 'a'), s('2.000000', 'b')],
      [s('1.000000', 'a'), s('2.000000', 'b'), s('3.000000', 'c')],
      [s('2.000000', 'b'), s('3.000000', 'c'), s('1.000000', 'a')],
    ].map((p) => rankClaims(p)[0].session))], ['a']);
  check('empty set ranks to nothing rather than throwing', rankClaims([]), []);

  // The other invariant: EVERY DECLARED FLAG APPEARS IN USAGE. Four flags shipped
  // invisible before this existed - see the long note in slack-post.mjs. Enforced in
  // all three scripts, because one enforced and two unenforced is how it drifts back.
  for (const f of Object.keys(OPTIONS)) {
    if (f === 'help') continue;
    check(`--${f} is documented in usage`, USAGE.includes(`--${f}`), true);
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall pass');
  process.exit(failed ? 1 : 0);
}

const OPTIONS = {
    channel: { type: 'string' },
    task: { type: 'string' },
    session: { type: 'string' },
    note: { type: 'string' },
    settle: { type: 'string', default: '2' },
    'ignore-stale': { type: 'boolean', default: false },
    // ⚠ WAS BRANCHED ON BUT NEVER DECLARED. parseArgs then threw "Unknown option
    // --takeover" when it was passed, while `!a.takeover` stayed true when it was
    // not - so the stale-takeover path could neither be reached nor refused
    // correctly. An undeclared flag fails in BOTH directions at once.
    takeover: { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

const { values: a } = parseArgs({ options: OPTIONS });

const label = a.session || process.env.CLAUDE_SESSION_NAME || (process.env.CLAUDE_CODE_SESSION_ID ?? '').slice(0, 8);

const USAGE =
  'usage: node slack-claim.mjs --channel <id> --task <ts> [--session <label>]\n' +
      '       [--note "..."] [--settle 2] [--ignore-stale] [--takeover] [--dry-run]\n' +
      '       [--self-test]\n' +
      '\n' +
      '  exit 0 = you hold the claim   exit 1 = you do not, stand down\n' +
      '\n' +
      '  --settle       seconds to wait before re-reading, covering read-after-write lag.\n' +
      '                 It is NOT a lock and does not make the claim exclusive.\n' +
      '  --ignore-stale treat a dead claimant as still holding the task.\n' +
      '  --takeover     required to take a task from a claimant judged STALE. Refused by\n' +
      '                 default: staleness is an inference from silence, and a quiet\n' +
      '                 session is not a dead one. --ping it first. A claimant that\n' +
      '                 ANNOUNCED its retirement is taken over without this - that is\n' +
      '                 positive evidence rather than an absence of it.\n' +
      '  --self-test    check the ranking rule, including the equal-ts tiebreak that this\n' +
      '                 transport cannot produce. Exits 0 all-pass, 1 on any failure.\n' +
      '\n' +
      '  QUOTE THE --task TIMESTAMP. A Slack ts has 16 significant digits; a shell that\n' +
  '  parses the bare token as a float rounds it, and Slack silently ignores it.';

if (a['self-test']) selfTest();

if (a.help || !a.channel || !a.task || !label) {
  console.error(USAGE);
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
const holder = rankClaims(before)[0] ?? null;

// Set when we decide a stale holder is abandoned. Its claim must then be excluded from
// the final ranking - otherwise the takeover is announced and immediately undone, because
// the abandoned claim still has the lowest ts and still wins.
let supersede = null;
// WHY the takeover happened, carried onto the claim so the thread records the grounds and
// not just the fact. §6's winner depends on a time-varying predicate, so the thread is the
// only durable evidence that the predicate was ever true - without it a wrong takeover is
// indistinguishable from a right one the moment the roster moves on.
let takeoverReason = null;
let takeoverEvidence = null;

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
  // ⛔ A STALE TAKEOVER IS OPT-IN. §6 is a liveness SIGNAL, not a LEASE: a wedged
    // session behind a running watcher reads alive, and a live session whose watcher
    // died reads stale. Automating that means silently deciding a peer is dead and
    // proceeding - the one operation you cannot afford to get wrong where
    // double-execution is destructive. A RETIREMENT is positive evidence and stays
    // automatic; an INFERENCE FROM SILENCE now requires someone to say so.
    if (!a.takeover) {
      console.log(`${holder.session} holds claim ${holder.ts} but is ${state}.`);
      console.log('NOT taking it over: that would be a judgement from a timeout, not proof.');
      console.log('');
      console.log(`  Ask it directly:   slack-watch.mjs --channel ${a.channel} --ping ${holder.session}`);
      console.log('  Then, accepting the risk:  --takeover');
      console.log('');
      console.log('⛔ If double-execution would be destructive - a deploy, a migration, a');
      console.log('   payment - do not pass --takeover. This is a signal, not a lease.');
      process.exit(1);
    }
    supersede = holder.session;
    takeoverReason = 'stale';
    takeoverEvidence = live ? `last-beat-${live.age}s` : 'no-presence';
    console.log(`${holder.session} holds claim ${holder.ts} but is ${state}.`);
    console.log('Taking it over on --takeover. A JUDGEMENT from a timeout, not proof:');
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
  const sc = before.find((c) => c.session === supersede);
  elements.push({ type: 'mrkdwn', text: `supersedes: \`${sc?.ts ?? supersede}\`` });
  if (takeoverReason) elements.push({ type: 'mrkdwn', text: `reason: \`${takeoverReason}\`` });
  if (takeoverEvidence) elements.push({ type: 'mrkdwn', text: `evidence: \`${takeoverEvidence}\`` });
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
            ? takeoverReason === 'retired'
              ? `Claiming this task, superseding *${supersede}*, which ANNOUNCED ITS RETIREMENT at ${takeoverEvidence}. ` +
                'That is positive evidence of departure, not a timeout: no staleness window was waited out.'
              : `Claiming this task, superseding *${supersede}* whose heartbeat has gone stale (${takeoverEvidence}). ` +
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
const ranked = rankClaims(after, { exclude: supersede });
const winner = ranked[0];

console.log(`Claims in thread (${after.length}):`);
for (const c of rankClaims(after)) {
  const mark = c.session === supersede ? `  <- superseded, ${takeoverReason ?? 'stale'}` : c.session === label ? '  <- you' : '';
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
