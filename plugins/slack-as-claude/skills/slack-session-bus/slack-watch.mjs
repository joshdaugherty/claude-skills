#!/usr/bin/env node
/**
 * Poll a Slack channel and print one line per new message.
 *
 * Designed to be the command of a Monitor: each stdout line becomes an event, so a
 * session finds out about a message instead of having to be told to go and look.
 * That is the whole point - see §5 of SKILL.md. Without something like this, the
 * channel is a bulletin board and a human is the delivery mechanism.
 *
 *   node slack-watch.mjs --channel C01234ABCDE
 *   node slack-watch.mjs --channel C01234ABCDE --interval 15 --ignore-session cea6f85a
 *   node slack-watch.mjs --channel C01234ABCDE --since 1788101338.332479 --once
 *
 * REQUIRES a bot token carrying channels:history (plus groups:/mpim:/im:history for
 * those conversation types). Adding it is a scope change: reinstall the app, and BOTH
 * tokens rotate. Without it every poll returns missing_scope - which this reports once
 * and then exits rather than looping on a permanent failure.
 *
 * Node 18+. No dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HISTORY = 'https://slack.com/api/conversations.history';

// Kept in step with slack-post.mjs. A type outside this set is either a deliberate
// custom one (x- prefixed) or a TYPO - and a typo'd claim is counted by nobody while
// the sender believes it claimed. Flag it loudly rather than letting it pass as noise.
const KNOWN_TYPES = ['request', 'reply', 'claim', 'done', 'fail', 'status'];

/**
 * This watcher's own plugin version, for comparison against senders'.
 *
 * ⚠ A version element that the READER drops is not a version element. An earlier build
 * emitted `plugin:` on every message to make skew detectable - and the watcher rendered
 * only to/type/thread and silently discarded it, so the field existed for exactly the
 * peer who could not see it. The signal has to survive the reader or it is decoration.
 */
function ownPlugin() {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) return null;
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    return m.version ? `${m.name || 'plugin'} ${m.version}` : null;
  } catch {
    return null;
  }
}
const OWN_PLUGIN = ownPlugin();

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

const { values: a } = parseArgs({
  options: {
    channel: { type: 'string' },
    interval: { type: 'string', default: '30' },
    since: { type: 'string' },
    replay: { type: 'boolean', default: false },
    session: { type: 'string' },
    heartbeat: { type: 'string', default: '0' },
    presence: { type: 'boolean', default: false },
    raw: { type: 'boolean', default: false },
    'ignore-session': { type: 'string', multiple: true, default: [] },
    'include-self': { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (a.help || !a.channel) {
  console.error(
    'usage: node slack-watch.mjs --channel <id> [--interval 30] [--since <ts>] [--replay]\n' +
      '       [--session <label>] [--heartbeat <sec>] [--presence] [--raw]\n' +
      '       [--ignore-session <label>]... [--include-self] [--once]\n' +
      '\n' +
      '  --heartbeat  publish liveness for --session, refreshed in place. Match the rate\n' +
      '               to the staleness window you care about, not to impatience.\n' +
      '  --presence   read the roster: who is alive, who is STALE. Pull, not push.\n' +
      '  --raw        INSPECTOR. Every message verbatim - raw ts, edited, every context\n' +
      '               element, undecoded body. No whitelist, no decode, no filtering.\n' +
      '               Reach for this the moment the rendering looks wrong: the renderer\n' +
      '               is where fields go to die.\n' +
      '\n' +
      '  By default the first poll primes the cursor silently and emits only NEW messages.\n' +
      '  --replay  emit the existing backlog too (it can contain closed work).\n' +
      '  --once    poll once and exit; always emits what it finds.\n' +
      '\n' +
      '  COLD START: bare is right - you do not want a backlog of closed work.\n' +
      '  RE-ARM:     pass --since <last ts you saw>. Priming would silently swallow\n' +
      '              anything posted between stopping the old watcher and starting this\n' +
      '              one, and the two cases look identical from inside the script.',
  );
  process.exit(a.help ? 0 : 1);
}

const token = botToken();
if (!token) {
  console.error('SLACK_BOT_TOKEN is not set.');
  process.exit(1);
}

const intervalMs = Math.max(5, Number(a.interval) || 30) * 1000;

// A session should not react to its own messages: it would see its own request as
// new work on the next restart. CLAUDE_SESSION_NAME (or the session id prefix) is
// how a message identifies its sender - see §1 of SKILL.md.
// --session is what this session POSTS as, which is not always what the environment
// says: a watcher is often launched with an explicit label while the env still holds
// a raw session id. Presence depends on getting this right - a heartbeat published
// under the wrong label is a heartbeat for a session nobody is looking for.
const selfLabel =
  a.session ||
  process.env.CLAUDE_SESSION_NAME ||
  (process.env.CLAUDE_CODE_SESSION_ID ? process.env.CLAUDE_CODE_SESSION_ID.slice(0, 8) : null);
const ignored = new Set(a['ignore-session']);
if (selfLabel && !a['include-self']) ignored.add(selfLabel);

/**
 * Pull the identity out of a message.
 *
 * ⚠ The RAW Web API and the MCP read tools give DIFFERENT shapes for the same message:
 *
 *   conversations.history  ->  text = the body only, blocks = structured
 *   mcp__slack__read_*     ->  the context block FLATTENED into the text as
 *                              "label: value" lines above the body
 *
 * So parsing `text` for a header works against the MCP tools and finds NOTHING here.
 * Read the context block's elements instead - which is better anyway: it cannot be
 * confused by prose in the body that happens to look like "to: someone".
 */
/**
 * Undo Slack's own mangling of message text.
 *
 * ⚠ Slack HTML-ESCAPES &, < and > when it stores a message. This matters far more
 * than it looks on a channel two coding sessions use to pass patches: `a && b` comes
 * back as `a &amp;&amp; b`, and pasting that into a shell or a .js file is SILENT
 * breakage, not a syntax error anyone notices. Confirmed on both read paths, so it is
 * Slack storing it escaped rather than a reader introducing it.
 *
 * Order matters: &amp; must be last, or "&amp;lt;" would decode twice.
 * Slack also angle-wraps URLs as <url> or <url|label>; unwrap to the bare form.
 */
function decodeSlack(s) {
  return (s ?? '')
    .replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseMessage(msg) {
  const meta = {};
  const ctx = (msg.blocks ?? []).find((b) => b.type === 'context');
  for (const el of ctx?.elements ?? []) {
    const m = (el.text ?? '').match(/^([a-z][a-z0-9_-]*):\s*(.*)$/i);
    if (m) meta[m[1].toLowerCase()] = decodeSlack(m[2]).replace(/^`|`$/g, '').trim();
  }
  // The body is the section block if there is one, else the plain text field.
  const section = (msg.blocks ?? []).find((b) => b.type === 'section');
  const body = section?.text?.text ?? msg.text ?? '';
  return { meta, body: decodeSlack(body).trim() };
}

// --- presence / liveness ----------------------------------------------------
//
// §6's problem: an IDLE session is byte-identical to a DEAD one holding a claim.
// Same silence, same last-seen ts, same absent `done`. No timeout separates them,
// because the channel carries evidence of ACTIVITY and never of LIVENESS.
//
// A session cannot fix this itself: it only executes during a turn, so a heartbeat
// it posts still proves activity. The WATCHER can, because it is a continuously
// running process whose lifetime tracks the session's under a persistent Monitor.
//
// So the watcher maintains ONE presence message, refreshed in place with chat.update
// (same ts, no channel spam, needs only chat:write). A reader compares `beat` against
// now: older than a couple of intervals and that session is gone.
//
// ⚠ WHAT THIS PROVES AND DOES NOT. It proves the WATCHER PROCESS is alive. A session
// whose watcher runs while it is itself wedged still looks alive; a live session whose
// watcher died looks dead. The second error is the safe direction; the first is not.
// This is a liveness signal, not a lease, and it does not make §6 safe for anything
// where double-execution is destructive.

const PRESENCE_TYPE = 'x-presence';
const STALE_AFTER = 2.5; // missed beats before a session is considered gone

async function slackPost(method, body) {
  return fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function recentMessages(limit = 200) {
  const url = new URL(HISTORY);
  url.searchParams.set('channel', a.channel);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return res.ok ? (res.messages ?? []) : [];
}

function presenceOf(msg) {
  const { meta } = parseMessage(msg);
  if (meta.type !== PRESENCE_TYPE || !meta.session) return null;
  // ⚠ The beat is SERVER-assigned: edited.ts if the message has ever been updated,
  // else its original ts. NOT a timestamp written into the body - that is
  // client-asserted, and a session with a skewed clock could report itself
  // alive-in-the-future or stale-in-the-past. Same reasoning as §4's ordering: if
  // Slack is the authority on when things happened, it is the authority here too.
  const beat = Number(msg.edited?.ts ?? msg.ts) || 0;
  return { ts: msg.ts, session: meta.session, beat, every: Number(meta.every) || 0 };
}

function presenceBlocks(label, every) {
  const beat = Math.floor(Date.now() / 1000);
  return {
    text: `presence: ${label}`,
    blocks: [
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `type: \`${PRESENCE_TYPE}\`` },
          { type: 'mrkdwn', text: `session: \`${label}\`` },
          { type: 'mrkdwn', text: `every: \`${every}\`` },
        ],
      },
      {
        // Plain UTC, NOT Slack's <!date^...> markup. That renders as a clock for a human
        // and reaches an agent as raw markup - a third way for the human view and the
        // agent view of one message to diverge, after the notification re-escape and the
        // CRLF diff. Anything on a bus is read by both; write it so both see the same.
        type: 'section',
        text: {
          type: 'mrkdwn',
          // The body MUST change on every beat, or Slack may treat the update as a no-op
        // and never set `edited` - which is the field the roster actually reads. This
        // line is for humans and to force the edit; it is NOT the authoritative beat.
        text: `_Watcher alive. Heartbeat every ${every}s; last beat ${new Date(beat * 1000).toISOString().replace('T', ' ').replace(/\..*/, '')} UTC._`,
        },
      },
    ],
  };
}

let presenceTs = null;

async function beat(label, every) {
  // Reuse this session's existing presence message if there is one, so a restart does
  // not litter the channel with orphans that a roster would then report as dead.
  if (!presenceTs) {
    for (const m of await recentMessages()) {
      const p = presenceOf(m);
      if (p && p.session === label) {
        presenceTs = p.ts;
        break;
      }
    }
  }
  const body = presenceBlocks(label, every);
  const res = presenceTs
    ? await slackPost('chat.update', { channel: a.channel, ts: presenceTs, ...body })
    : await slackPost('chat.postMessage', { channel: a.channel, ...body });
  if (res.ok) presenceTs = res.ts;
  else console.error(`[watch] heartbeat failed: ${res.error}`);
}

async function roster() {
  const now = Math.floor(Date.now() / 1000);
  const seen = new Map();
  for (const m of await recentMessages()) {
    const p = presenceOf(m);
    if (p && (!seen.has(p.session) || seen.get(p.session).beat < p.beat)) seen.set(p.session, p);
  }
  if (!seen.size) {
    console.log('no presence messages found - no session is publishing a heartbeat');
    return;
  }
  for (const [label, p] of [...seen].sort()) {
    // A presence message with no usable beat is MALFORMED, not ancient. Reporting it
    // as "last beat 1788104193s ago" is arithmetic on a missing field dressed up as a
    // measurement, and it reads like a real observation about a real session.
    if (!p.beat) {
      console.log(`${'?'.padEnd(5)} ${label.padEnd(16)} malformed presence message - no beat field`);
      continue;
    }
    const age = now - p.beat;
    const limit = (p.every || 60) * STALE_AFTER;
    const state = age > limit ? 'STALE' : 'alive';
    console.log(`${state.padEnd(5)} ${label.padEnd(16)} last beat ${age}s ago (every ${p.every}s)`);
  }
  console.log('\nSTALE means the watcher stopped publishing - the session is gone, or its watcher died.');
  console.log('It does NOT prove the session is wedged, and alive does NOT prove it is responsive.');
}

let cursor = a.since ?? null;
let reportedEmptyScope = false;

// Observed hazard: armed with no cursor, the first poll emits the whole recent channel,
// and a CLOSED task replays looking exactly like new work. A session that trusts its
// watcher rather than re-reading the thread would execute something resolved long ago.
// So the first poll silently establishes the cursor instead. History is opt-in.
//
// ...EXCEPT under --once, which is a single manual probe: there is no long-lived cursor
// to protect and nothing to replay into, and history is the whole point of asking. Priming
// it would make "--once" a silent no-op that exits 0 - indistinguishable from a quiet
// channel, on the exact command someone runs to check their setup works.
let priming = !a.since && !a.replay && !a.once;

async function poll() {
  const url = new URL(HISTORY);
  url.searchParams.set('channel', a.channel);
  url.searchParams.set('limit', '50');
  // `oldest` is exclusive when inclusive=false (the default), so the last-seen
  // message is not re-emitted.
  if (cursor) url.searchParams.set('oldest', cursor);

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  } catch (err) {
    // Transient: a failed request must not kill a long-running watch.
    console.error(`[watch] request failed: ${err.message}`);
    return true;
  }

  if (!res.ok) {
    if (res.error === 'missing_scope') {
      if (!reportedEmptyScope) {
        console.error(
          `[watch] missing_scope: the bot token cannot read history.\n` +
            `        needed:   ${res.needed}\n` +
            `        provided: ${res.provided}\n` +
            `        Add channels:history under Bot Token Scopes and reinstall (both tokens rotate).`,
        );
        reportedEmptyScope = true;
      }
      return false; // permanent - do not loop on it
    }
    console.error(`[watch] ${res.error}`);
    return res.error !== 'channel_not_found' && res.error !== 'invalid_auth';
  }

  // Slack returns newest-first; emit oldest-first so events read in order.
  const fresh = (res.messages ?? []).slice().reverse();

  if (priming) {
    // Advance the cursor past everything already in the channel, emitting nothing.
    let skipped = 0;
    for (const m of fresh) {
      if (m.ts) cursor = m.ts;
      if (m.subtype !== 'channel_join' && m.subtype !== 'channel_leave') skipped++;
    }
    priming = false;

    // ⚠ Report the COUNT, not just the cursor. Priming is right for a COLD start and
    // wrong for a HANDOVER - re-arm bare after stopping a watcher and anything posted
    // in between is swallowed silently. The two are indistinguishable from in here:
    // both are "starting with no cursor". Naming the number at least makes the hole
    // visible at the exact moment someone is being careful about coverage.
    console.error(
      `[watch] primed at ts=${cursor ?? 'none'} - skipped ${skipped} existing message(s), watching for new only.` +
        (skipped > 0
          ? '\n[watch] If this was a RE-ARM rather than a cold start, those were dropped: restart with --since <last ts you saw>.'
          : ''),
    );
    return true;
  }

  for (const m of fresh) {
    if (m.ts) cursor = m.ts;
    if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue;

    const { meta, body } = parseMessage(m);
    const from = meta.session ?? '?';
    if (ignored.has(from)) continue;

    const to = meta.to ? ` to=${meta.to}` : '';
    let type = '';
    if (meta.type) {
      const known = KNOWN_TYPES.includes(meta.type) || meta.type.startsWith('x-');
      // An unrecognised type is surfaced, not swallowed: silently unmatched is exactly
      // how a peer's typo turns into two sessions doing the same work.
      type = known ? ` type=${meta.type}` : ` type=${meta.type}!UNKNOWN`;
    }
    const thread = m.thread_ts && m.thread_ts !== m.ts ? ` thread=${m.thread_ts}` : '';
    // An edit keeps the ORIGINAL ts, so oldest=<cursor> never returns the message
    // again: an edit is either seen or lost, never seen AS an edit. Surfacing
    // m.edited at least stops a revised message passing as an original.
    const edited = m.edited ? ` (edited@${m.edited.ts})` : '';

    // Version skew: quiet when it matches, loud when it does not. Rendering every
    // sender's version on every line would be noise nobody reads; rendering only the
    // MISMATCH puts it in front of you exactly when it can mislead you - which is the
    // moment a peer appears to lack a capability that has simply not shipped to it.
    let plugin = '';
    if (!meta.plugin) plugin = ' plugin=?';
    else if (OWN_PLUGIN && meta.plugin !== OWN_PLUGIN) plugin = ` plugin=${meta.plugin}!SKEW(you=${OWN_PLUGIN})`;

    // One line per message: each becomes a single Monitor event.
    console.log(`[bus] ts=${m.ts} from=${from}${to}${type}${thread}${plugin}${edited} :: ${body.replace(/\s+/g, ' ')}`);
  }
  return true;
}

// Roster mode: report who is alive and exit. Not a watch.
if (a.presence) {
  await roster();
  process.exit(0);
}

/**
 * Inspector mode. Dumps every message verbatim: raw ts, edited, subtype, every context
 * element exactly as sent, and the undecoded body.
 *
 * ★ THIS EXISTS BECAUSE THE RENDERER IS WHERE FIELDS GO TO DIE. Three times in one
 * afternoon the fix for a visibility problem was itself invisible - a heartbeat the peer
 * had no instrument to read, a version element the renderer dropped, unknown-type
 * flagging absent from the process that wrote it. Every one was caught by leaving the
 * renderer behind and reading the payload.
 *
 * That discipline was working but unshipped: it meant writing a throwaway script each
 * time. A rule asks for intention; a command asks for a keystroke. So the toolkit gets
 * exactly one path with NO renderer in it - no whitelist, no decoding, no filtering,
 * not even the self-ignore. If a field is on the wire, it appears here.
 */
if (a.raw) {
  const msgs = (await recentMessages(a.since ? 200 : 20)).slice().reverse();
  for (const m of msgs) {
    if (a.since && Number(m.ts) <= Number(a.since)) continue;
    const bits = [`ts=${m.ts}`];
    if (m.edited) bits.push(`edited=${m.edited.ts}`);
    if (m.thread_ts && m.thread_ts !== m.ts) bits.push(`thread=${m.thread_ts}`);
    if (m.subtype) bits.push(`subtype=${m.subtype}`);
    if (m.username) bits.push(`username=${JSON.stringify(m.username)}`);
    console.log(`--- ${bits.join(' ')}`);
    for (const b of m.blocks ?? []) {
      if (b.type === 'context') for (const e of b.elements ?? []) console.log(`    ctx  | ${e.text ?? JSON.stringify(e)}`);
      else if (b.type === 'section') console.log(`    sect | ${b.text?.text ?? ''}`);
      else console.log(`    ${b.type} | ${JSON.stringify(b)}`);
    }
    console.log(`    text | ${m.text ?? ''}`);
  }
  console.log(`\n${msgs.length} message(s), verbatim - no decode, no filtering, no whitelist.`);
  process.exit(0);
}

const heartbeatSec = Math.max(0, Number(a.heartbeat) || 0);
if (heartbeatSec > 0) {
  if (!selfLabel) {
    console.error('--heartbeat needs a session label: pass --session, or set CLAUDE_SESSION_NAME.');
    process.exit(1);
  }
  if (heartbeatSec < 30) {
    console.error(
      `[watch] heartbeat of ${heartbeatSec}s is for TESTING. Match it to the staleness window you\n` +
        '        actually care about - one beat a minute against a ten-minute N, not one every\n' +
        '        five seconds. Beating faster does not make liveness more true, it just costs.',
    );
  }
  await beat(selfLabel, heartbeatSec);
  console.error(`[watch] publishing presence as "${selfLabel}" every ${heartbeatSec}s (read it with --presence)`);
  // Deliberately on its own timer rather than tied to the poll interval: how often you
  // check for messages and how often you prove you are alive are different questions.
  setInterval(() => beat(selfLabel, heartbeatSec), heartbeatSec * 1000).unref?.();
}

const keepGoing = await poll();
if (a.once || !keepGoing) process.exit(keepGoing ? 0 : 1);

// eslint-disable-next-line no-constant-condition
while (true) {
  await new Promise((r) => setTimeout(r, intervalMs));
  if (!(await poll())) process.exit(1);
}
