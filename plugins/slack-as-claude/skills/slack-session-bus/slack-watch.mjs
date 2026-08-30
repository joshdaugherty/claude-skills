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
import { parseArgs } from 'node:util';

const HISTORY = 'https://slack.com/api/conversations.history';

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
    'ignore-session': { type: 'string', multiple: true, default: [] },
    'include-self': { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (a.help || !a.channel) {
  console.error(
    'usage: node slack-watch.mjs --channel <id> [--interval 30] [--since <ts>] [--replay]\n' +
      '       [--ignore-session <label>]... [--include-self] [--once]\n' +
      '\n' +
      '  By default the first poll primes the cursor silently and emits only NEW messages.\n' +
      '  --replay  emit the existing backlog too (it can contain closed work).\n' +
      '  --once    poll once and exit; always emits what it finds.',
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
const selfLabel =
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
    for (const m of fresh) if (m.ts) cursor = m.ts;
    priming = false;
    console.error(`[watch] primed at ts=${cursor ?? 'none'} - watching for new messages only (--replay for history)`);
    return true;
  }

  for (const m of fresh) {
    if (m.ts) cursor = m.ts;
    if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue;

    const { meta, body } = parseMessage(m);
    const from = meta.session ?? '?';
    if (ignored.has(from)) continue;

    const to = meta.to ? ` to=${meta.to}` : '';
    const type = meta.type ? ` type=${meta.type}` : '';
    const thread = m.thread_ts && m.thread_ts !== m.ts ? ` thread=${m.thread_ts}` : '';
    // One line per message: each becomes a single Monitor event.
    console.log(`[bus] ts=${m.ts} from=${from}${to}${type}${thread} :: ${body.replace(/\s+/g, ' ')}`);
  }
  return true;
}

const keepGoing = await poll();
if (a.once || !keepGoing) process.exit(keepGoing ? 0 : 1);

// eslint-disable-next-line no-constant-condition
while (true) {
  await new Promise((r) => setTimeout(r, intervalMs));
  if (!(await poll())) process.exit(1);
}
