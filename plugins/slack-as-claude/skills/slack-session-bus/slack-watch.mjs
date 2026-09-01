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
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HISTORY = 'https://slack.com/api/conversations.history';

// Kept in step with slack-post.mjs. A type outside this set is either a deliberate
// custom one (x- prefixed) or a TYPO - and a typo'd claim is counted by nobody while
// the sender believes it claimed. Flag it loudly rather than letting it pass as noise.
const KNOWN_TYPES = ['request', 'reply', 'claim', 'done', 'fail', 'status'];

// ⚠ A BUS ACCUMULATES IDENTITIES AND NEVER RETIRES THEM. Every label that ever spoke is
// a peer forever: dead sessions, one-off test fixtures, a name used once by mistake.
//
// ⛔⛔ BUT SILENCE IS NOT EVIDENCE OF ABSENCE, AND THIS IS EASY TO GET WRONG. A
// long-lived session can be perfectly alive and simply have nothing to say for hours.
// Ageing it out would declare it gone for the crime of being quiet.
//
// So the three states are distinguished by WHAT THE SESSION PROMISED, not by silence:
//
//   BEATING             -> alive. It said it would beat, and it is.
//   BEAT AND STOPPED    -> STALE. Silence is meaningful ONLY here, because it broke a
//                          promise it made. This is still an inference, not proof.
//   NEVER BEAT          -> quiet. Status UNKNOWN. It never promised anything, so its
//                          silence says nothing at all - it may be idle and healthy.
//
// Age-out therefore applies to DISPLAY of quiet sessions only. It never frees a claim:
// only an announced retirement (positive evidence) or a broken heartbeat promise
// (inference, with a stated timeout) can do that. See slack-claim.mjs.
const GONE_AFTER_DEFAULT = 14400;

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
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = join(here, '..', '..', '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) return null;
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!m.version) return null;
    // +dev marks an AUTHORING TREE: it carries the version it is based on, not of the
    // code it runs, so an unreleased file otherwise announces a version not containing
    // it. Reporting equal while meaning unequal is the one thing a version must not do.
    const dev = here.includes(join('.claude', 'plugins', 'cache')) ? '' : '+dev';
    return `${m.name || 'plugin'} ${m.version}${dev}`;
  } catch {
    return null;
  }
}
const OWN_PLUGIN = ownPlugin();

/**
 * WHICH environment variable holds this repo's credential.
 *
 * ⚠ THE VARIABLE NAME IS NOT A SECRET; THE TOKEN IS. So the repo may name its own
 * variable in the committed declaration, while the value stays machine-side exactly as
 * before. That is what lets TWO repos on ONE machine hold TWO credentials without either
 * mutating shared state or repointing the other - the refusal alone made a collision
 * safe, this makes it unnecessary.
 *
 *     { "team_id": "T0123456789", "token_env": "SLACK_BOT_TOKEN_ACME" }
 *
 * Defaults to SLACK_BOT_TOKEN, so a machine with one workspace needs no declaration and
 * behaves exactly as it did.
 */
function tokenVar() {
  try {
    return repoWorkspace()?.token_env || 'SLACK_BOT_TOKEN';
  } catch {
    return 'SLACK_BOT_TOKEN';
  }
}

function botToken() {
  const VAR = tokenVar();
  if (process.env[VAR]) return process.env[VAR];
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', VAR], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(new RegExp(VAR + '\\s+REG_(?:EXPAND_)?SZ\\s+(\\S+)'));
      if (m) return m[1];
    } catch {
      /* not there either */
    }
  }
  return null;
}

const OPTIONS = {
    channel: { type: 'string' },
    interval: { type: 'string', default: '30' },
    since: { type: 'string' },
    replay: { type: 'boolean', default: false },
    session: { type: 'string' },
    heartbeat: { type: 'string', default: '0' },
    presence: { type: 'boolean', default: false },
    raw: { type: 'boolean', default: false },
    doctor: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    'gone-after': { type: 'string' },
    retire: { type: 'boolean', default: false },
    audit: { type: 'string' },
    releases: { type: 'string' },
    ping: { type: 'string' },
    wait: { type: 'string', default: '45' },
    'ignore-session': { type: 'string', multiple: true, default: [] },
    'include-self': { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

const { values: a } = parseArgs({ options: OPTIONS });

const USAGE =
    'usage: node slack-watch.mjs --channel <id> [--interval 30] [--since <ts>] [--replay]\n' +
      '       [--session <label>] [--heartbeat <sec>] [--presence] [--raw]\n' +
      '       [--ignore-session <label>]... [--include-self] [--once]\n' +
      '\n' +
      '       [--heartbeat <sec>] [--retire] [--releases <ts,ts>] [--all]\n' +
      '       [--ping <session>] [--wait <sec>] [--gone-after <sec>]\n' +
      '\n' +
      '  --heartbeat <sec>  publish liveness for --session, refreshed in place. Match the\n' +
      '               rate to the staleness window you care about, not to impatience.\n' +
      '  --presence   read the roster: who is alive, who is STALE. Pull, not push.\n' +
      '  --all        also list sessions not seen recently, which --presence hides.\n' +
      '               NOT SEEN IS NOT GONE: a long-lived session can be quietly alive.\n' +
      '  --gone-after <sec>  how long before a quiet session is hidden (default 14400).\n' +
      '  --ping <session>  ask ONE session BY NAME if it is there, and wait for a pong.\n' +
      '               A PONG IS PROOF. NO PONG IS NOT EVIDENCE. A broadcast ping measures\n' +
      '               nothing - every correctly-filtering session stays silent and so\n' +
      '               reads as dead. A named session must answer unconditionally.\n' +
      '  --wait <sec>  how long to wait for that pong (default 45).\n' +
      '  --retire     announce departure, then delete your presence message. POSITIVE\n' +
      '               evidence of absence, so a peer can skip the staleness timeout\n' +
      '               instead of inferring it from silence.\n' +
      '  --releases <ts,ts>  claims you are handing back as you retire.\n' +
      '  --audit <thread-ts>  list replies present in the THREAD but absent from the\n' +
      '               channel timeline - messages no watcher can see. --raw CANNOT find\n' +
      '               these: it reads history, and the failure IS absence from history.\n' +
      '               Exits 1 if any are found.\n' +
      '  --doctor     Am I behind? Compares RUNNING / INSTALLED / AVAILABLE / PEERS by\n' +
      '               BYTES, not version numbers, and prints what to ask a human for.\n' +
      '  --raw        INSPECTOR. Every message verbatim - raw ts, edited, every context\n' +
      '               element, undecoded body. No whitelist, no decode, no filtering.\n' +
      '               Reach for this the moment the rendering looks wrong: the renderer\n' +
      '               is where fields go to die.\n' +
      '\n' +
      '  By default the first poll primes the cursor silently and emits only NEW messages.\n' +
      '  --replay  emit the existing backlog too (it can contain closed work).\n' +
      '  --once    poll once and exit; always emits what it finds.\n' +
      '\n' +
      '  --self-test  check that every declared flag appears in this usage text. Four\n' +
      '               flags have shipped invisible; this is the check that stops it.\n' +
      '\n' +
      '  COLD START: bare is right - you do not want a backlog of closed work.\n' +
      '  RE-ARM:     pass --since <last ts you saw>. Priming would silently swallow\n' +
      '              anything posted between stopping the old watcher and starting this\n' +
      '              one, and the two cases look identical from inside the script.';

/**
 * EVERY DECLARED FLAG MUST APPEAR IN USAGE - see the long note in slack-post.mjs.
 * Four flags shipped invisible before this check existed, and the audit meant to catch
 * them gave a FALSE PASS by grepping the whole file instead of the usage text.
 */
function selfTest() {
  const flags = Object.keys(OPTIONS).filter((f) => f !== 'help');
  const missing = flags.filter((f) => !USAGE.includes(`--${f}`));
  for (const f of flags) console.log(`  ${USAGE.includes(`--${f}`) ? 'pass' : 'FAIL'}  --${f}`);
  console.log(
    missing.length ? `\n${missing.length} FLAG(S) MISSING FROM USAGE: ${missing.join(', ')}` : '\nall pass',
  );
  process.exit(missing.length ? 1 : 0);
}

if (a['self-test']) selfTest();

if (a.help || !a.channel) {
  console.error(USAGE);
  process.exit(a.help ? 0 : 1);
}

const token = botToken();
if (!token) {
  console.error(`${tokenVar()} is not set.`);
  process.exit(1);
}

const intervalMs = Math.max(5, Number(a.interval) || 30) * 1000;
const GONE_AFTER_SEC = Math.max(60, Number(a['gone-after']) || GONE_AFTER_DEFAULT);

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
  /**
   * ⛔⛔⛔ EVERY section BLOCK, NOT THE FIRST ONE. `.find()` SILENTLY TRUNCATED.
   *
   * slack-post SPLITS a body over 2900 chars across SEVERAL section blocks, because a
   * single Slack section caps at 3000 and the post fails with invalid_blocks otherwise.
   * This read the FIRST section and dropped the rest - so any message longer than one
   * block arrived with its tail missing, and nothing anywhere said so.
   *
   * ★ The sender saw a successful post. The reader saw a message that simply ended. Both
   * surfaces were internally consistent and neither could see the gap, which is why it
   * survived a full day of two sessions doing nothing but read each other closely.
   *
   * ⚠ MEASURED AT THE MOMENT OF THE FIX, over the channel's own history:
   *
   *     182 messages carrying a section block
   *      24 SPLIT across more than one
   *   14761 characters never shown to any reader
   *
   * Both sessions, all day, in the conversation that kept finding this exact class of
   * defect elsewhere. The cost was not hypothetical: a proposal addressed to a peer sat
   * in an unread tail and was re-raised as "you did not answer".
   *
   * ★ AND IT IS THE WRITER/READER PAIR AGAIN. sectionBlocks() was added deliberately, for
   * a real Slack limit, and correctly. Nothing updated the reader to match - the same
   * shape as `resolutions()` and `recentMessages()`: A FIX OR FEATURE VERIFIED ONLY ON
   * THE PATH THAT MOTIVATED IT LEAVES ITS COUNTERPART BROKEN.
   */
  const sections = (msg.blocks ?? []).filter((b) => b.type === 'section');
  const parts = sections.map((s) => s.text?.text ?? '');
  const body = parts.length ? parts.join('') : (msg.text ?? '');

  /**
   * ★ COUNT THE SEAMS WHERE NOTHING WAS STORED, AND SAY SO.
   *
   * Joining is exact only where the writer KEPT the separator. A writer before this fix
   * stripped it, so `A\n\nB`, `A\nB`, `A B` and `AB` all stored as `[A][B]` with nothing
   * on either side - a many-to-one map with no inverse. Those seams cannot be repaired by
   * anyone who does not still hold the pre-send original, and for most of an archive
   * nobody does.
   *
   * ⚠ THE READER CANNOT RECOVER THEM, BUT IT CAN ALWAYS TELL. The discriminator is a
   * property of the STORED MESSAGE - no version lookup, no metadata: does the NEXT block
   * begin with whitespace? Present means the separator survived and the join is exact.
   * Absent means nothing was stored there and the join is a guess.
   *
   * ★ THE TEST ASKS ABOUT THE PROPERTY, NOT THE ERA, DELIBERATELY. "Nothing is stored at
   * this seam" is true both for an old writer that stripped a separator AND for a
   * post-fix hard cut at 2900 where there was none to keep. Those two are exactly the
   * pair that cannot be distinguished - so a marker that declines to distinguish them is
   * CORRECT rather than imprecise. It reports only what is knowable.
   *
   * This repairs nothing. It stops the reader handing back a guess as a reading.
   */
  let bareSeams = 0;
  for (let i = 1; i < parts.length; i += 1) if (!/^\s/.test(parts[i])) bareSeams += 1;

  return { meta, body: decodeSlack(body).trim(), seams: Math.max(0, parts.length - 1), bareSeams };
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
// ⚠ An ABSOLUTE FLOOR, because a threshold proportional to the claimant's own declared
// rate is inverted: at every=5 a session went STALE in 12.5s while one declaring 60s got
// 150s. THE SESSION PROVING ITSELF TWELVE TIMES MORE OFTEN GOT TWELVE TIMES LESS
// TOLERANCE - a fast heartbeat is MORE evidence of life and was punished for it, and one
// scheduler hiccup would kill it. Declaring an aggressive rate must not make you fragile.
const STALE_FLOOR_SEC = 90;


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
  /**
   * ⛔⛔⛔ A FAILED READ IS NOT AN EMPTY CHANNEL.
   *
   * This returned `[]` on failure, so every caller was unable to distinguish "nothing is
   * there" from "I could not ask" - and five surfaces then reported a confident absence
   * they had never observed. With an invalid token: `--presence` said "no session is
   * publishing a heartbeat", `--raw` said "0 message(s)", and `--doctor` said
   * "PEERS none live" AND ADVISED ON IT, telling a session with a healthy watcher to arm
   * a second one. Every sentence of that advice was an inference from an `invalid_auth`.
   *
   * ★ The codebase had already named this class twice and fixed it twice, both times in
   * slack-claim.mjs - `resolutions()` ("UNKNOWN MUST NOT RENDER AS OPEN") and
   * `livenessOf()` ("A FAILED READ IS NOT AN ABSENT HEARTBEAT"). The sibling path here
   * was never given the same treatment, which is the repo's own lesson biting: A FIX
   * VERIFIED ONLY ON THE PATH THAT REPORTED THE BUG LEAVES ITS SIBLINGS BROKEN.
   *
   * ⚠ The two worst-hit surfaces are the two built for use when something ALREADY looks
   * wrong: `--raw` is the inspector, and rendering an empty channel is the single most
   * misleading answer it can give; `--doctor` answers "am I behind?" with fabricated
   * absence. And `--presence` is the evidence a human is told to consult before allowing
   * a `--takeover`, so it fed the wrong input to the one decision the design insists must
   * not be automated.
   *
   * The shape is deliberate: callers must destructure, so a site that ignores `ok` reads
   * as obviously wrong rather than quietly wrong.
   */
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return res.ok ? { ok: true, messages: res.messages ?? [] } : { ok: false, error: res.error, messages: [] };
}

/**
 * ⚠ ADDED WITH THE WORKSPACE CHECK, AND NEARLY FORGOTTEN - which is issue #1 exactly.
 * die() was called from a shared block that assumed every script had one. slack-post had
 * it, slack-claim had it only after #1 was fixed, and this file had NEITHER. Pasting the
 * block in unchanged would have reintroduced the same ReferenceError in a third file.
 * A shared body copied between standalone scripts inherits nothing - check what it needs.
 */
function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function gitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// --- workspace binding ------------------------------------------------------

/**
 * ⛔⛔⛔ POSTING TO THE WRONG WORKSPACE RETURNS ok: true.
 *
 * A `xoxb-` token is scoped per app PER WORKSPACE. If the machine's token belongs to
 * workspace A and this repo is meant to talk to workspace B, the post SUCCEEDS - it
 * simply lands somewhere nobody is reading, and the success line is byte-identical to a
 * correct one. No error, no warning, nothing in the response to check.
 *
 * ★ Reported from the field after exactly that happened, and found only by calling
 * auth.test by hand. It is the same class this file has already fixed twice - a WRONG
 * value rendering exactly like a right one - pointed at the destination rather than at
 * the content, and it becomes reachable the moment a second workspace exists, because
 * that is when the wrong token stops being impossible and starts being selectable.
 *
 * THE BINDING IS A PROPERTY OF THE REPO, AND IT IS ONE-TO-ONE. A checkout talks to one
 * workspace, and two IDE windows on the same tree cannot disagree about which - so it is
 * declared in a committed file at the git root, not in the environment:
 *
 *     <repo>/.claude/slack-workspace.json
 *     { "team_id": "T0123456789", "team": "Acme" }
 *
 * ⚠ THE SPLIT IS DELIBERATE. The DESTINATION is repo-scoped, carries no secret, and is
 * committable so collaborators inherit it. The CREDENTIAL stays machine-scoped in
 * process.env / HKCU\Environment and is never committed. Routing the destination through
 * the environment instead would inherit the launch-time inheritance trap documented in
 * SKILL.md §2 - a running process cannot see a variable set after it started. A file in
 * the checkout is read at CALL time, so that trap does not apply to it at all.
 *
 * `team_id` is the strongest key: exact, and stable across workspace renames. `team` and
 * `url` are accepted for convenience and matched case-insensitively when present.
 */
function repoWorkspace() {
  const root = gitRoot();
  if (!root) return null;
  const p = join(root, '.claude', 'slack-workspace.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j.team_id && !j.team && !j.url) {
      die(`${p} declares no workspace.\n  Give it at least one of: team_id (best), team, url.`, 2);
    }
    return { ...j, path: p };
  } catch (e) {
    if (e?.code === 'ERR_INVALID_ARG_TYPE' || e instanceof SyntaxError) {
      die(`${p} is not valid JSON: ${e.message}`, 2);
    }
    throw e;
  }
}

/** Who does this token actually belong to? One call, and it is the only source of truth. */
async function whoAmI(token) {
  try {
    const j = await (
      await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    ).json();
    return j.ok ? { ok: true, team: j.team, team_id: j.team_id, url: j.url } : { ok: false, error: j.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Verify the token's workspace against the repo's declaration. Returns the identity so
 * callers can DISPLAY it even when there is nothing to enforce.
 *
 * ⚠ NO DECLARATION MEANS NO ENFORCEMENT, deliberately: an existing single-workspace
 * machine must keep working with no configuration at all. The check is opt-in by adding
 * the file, which is also the moment a second workspace becomes possible.
 */
async function checkWorkspace(token, { enforce = true } = {}) {
  const want = repoWorkspace();
  const who = await whoAmI(token);
  if (!who.ok) {
    // A failed auth.test is NOT a mismatch - it is an unanswered question. Say which.
    if (want && enforce) {
      die(
        `Could not verify which workspace this token belongs to: ${who.error}\n` +
          `  ${want.path} requires a match, and an unanswered question is not a match.\n` +
          '  Refusing rather than posting somewhere unverified.',
        2,
      );
    }
    return { who, want, verified: false };
  }
  if (!want) return { who, want: null, verified: false };

  const eq = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const sub = (u) => String(u ?? '').replace(/^https?:\/\//, '').split('.')[0];
  const match = want.team_id
    ? eq(want.team_id, who.team_id)
    : want.team
      ? eq(want.team, who.team)
      : eq(sub(want.url), sub(who.url));

  if (!match && enforce) {
    die(
      'WORKSPACE MISMATCH - refusing to send.\n' +
        `  this repo expects : ${want.team_id ?? want.team ?? want.url}\n` +
        `  the token belongs : ${who.team} (${who.team_id})  ${who.url}\n` +
        `  declared in       : ${want.path}\n` +
        '\n' +
        '  Sending anyway would have SUCCEEDED and returned ok:true, landing the message\n' +
        '  in a workspace nobody is reading. That is why this refuses instead of warning.\n' +
        '\n' +
        '  Fix whichever is wrong: point SLACK_BOT_TOKEN at the expected workspace, or\n' +
        '  correct the declaration.',
      2,
    );
  }
  return { who, want, verified: match };
}

/** One line naming the destination, for surfaces that describe a send without making one. */
function workspaceLine({ who, want, verified }) {
  if (!who.ok) return `unverified (auth.test failed: ${who.error})`;
  const base = `${who.team} (${who.team_id})  ${who.url}`;
  if (!want) return `${base}  [no repo declaration - unenforced]`;
  return `${base}  [${verified ? 'matches' : 'DOES NOT MATCH'} ${want.path}]`;
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
          // Carry the version on the heartbeat too. A live session's presence message is
          // its most reliable recent word - a peer might not have POSTED in an hour, but
          // if it is alive it is beating. Without this, a session that is up to date and
          // simply quiet reads as "not announcing a version - necessarily older".
          ...(OWN_PLUGIN ? [{ type: 'mrkdwn', text: `plugin: \`${OWN_PLUGIN}\`` }] : []),
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
    // Fail-safe, and it now SAYS which case it is in: on a failed lookup we post a fresh
    // presence message rather than updating in place. That is a safe degradation (a
    // duplicate beats a missing heartbeat) but it litters, so it must not be silent.
    const look = await recentMessages();
    if (!look.ok) console.error(`[watch] could not look up an existing presence message (${look.error}); posting a NEW one, which may leave an orphan.`);
    for (const m of look.messages) {
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

/**
 * ★★★★ A MESSAGE IS BETTER LIVENESS EVIDENCE THAN A HEARTBEAT.
 *
 * A beat proves A TIMER FIRED inside a process. A message proves THE SESSION ACTED.
 * That is the same distinction that makes a pong worth more than a beat - and for a
 * long time this roster read only the weaker signal, in a channel already carrying the
 * stronger one.
 *
 * ⛔ THE COST WAS A LIVE SESSION READING AS DEAD. A session that is posting but not
 * beating - between watcher restarts, or running a poster with no watcher at all - was
 * absent from the roster while being demonstrably alive in the transcript directly
 * above it. Observed THREE times in one day, and once it produced a wrong instruction:
 * a session read the roster, concluded a peer had not restarted, and told it to, while
 * that peer's messages sat in the very channel being read. THE EVIDENCE THAT WOULD HAVE
 * CORRECTED IT WAS ALREADY ON THE BUS. No instrument was looking at it.
 *
 * ⚠ The two signals mean DIFFERENT things and are not merged into one verdict:
 *
 *     alive   beating       - a watcher is running and publishing
 *     active  posted only   - the session ACTED recently but publishes no usable beat;
 *                             it cannot be --ping'd and will not answer a liveness probe
 *     STALE   neither, recently enough to still be worth naming
 *
 * `active` is deliberately NOT called alive. A posting session is present but not
 * REACHABLE, and a takeover decision needs to know which of those it has.
 */
function lastSpokeAt(msgs, meta) {
  return msgs.reduce((best, m) => {
    const { meta: mm } = parseMessage(m);
    if (mm.session !== meta) return best;
    const ts = Number(m.ts) || 0;
    return ts > best ? ts : best;
  }, 0);
}

async function roster() {
  const now = Math.floor(Date.now() / 1000);
  const read = await recentMessages();
  if (!read.ok) {
    console.error(`could not read the channel: ${read.error}`);
    console.error('This is NOT "no session is publishing a heartbeat" - that is a claim about');
    console.error('your peers, and nothing was learned about them. Do not treat any session as');
    console.error('stale on the strength of this, and do not authorise a --takeover from it.');
    process.exit(1);
  }
  const msgs = read.messages;
  const seen = new Map();
  for (const m of msgs) {
    const p = presenceOf(m);
    if (p && (!seen.has(p.session) || seen.get(p.session).beat < p.beat)) seen.set(p.session, p);
  }
  // Sessions that have SPOKEN but publish no presence. Formerly invisible here entirely.
  const spoke = new Map();
  for (const m of msgs) {
    const { meta } = parseMessage(m);
    if (!meta.session || seen.has(meta.session)) continue;
    const ts = Number(m.ts) || 0;
    if (ts > (spoke.get(meta.session) ?? 0)) spoke.set(meta.session, ts);
  }
  // Rendered AFTER the beating sessions, below - a roster is read top-down for "who is
  // working", and a non-beater is the weaker answer. Only recent ones are shown by
  // default: a label that neither beats NOR has spoken lately is gone, and listing every
  // one-off that ever posted is precisely the graveyard the age-out exists to prevent.
  const active = [...spoke]
    .map(([label, ts]) => [label, Math.max(0, Math.floor(now - ts))])
    .filter(([, age]) => a.all || age <= STALE_FLOOR_SEC)
    .sort((x, y) => x[1] - y[1]);

  if (!seen.size && !active.length) {
    console.log('no presence messages found - no session is publishing a heartbeat');
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const gone = [...seen].filter(([, p]) => p.beat && nowSec - p.beat > GONE_AFTER_SEC);
  for (const [label, p] of [...seen].sort()) {
    // Aged out: not listed. A session silent for an hour is not "stale", it is gone, and
    // listing it forever is what turns a roster into a graveyard.
    if (!a.all && p.beat && nowSec - p.beat > GONE_AFTER_SEC) continue;
    // A presence message with no usable beat is MALFORMED, not ancient. Reporting it
    // as "last beat 1788104193s ago" is arithmetic on a missing field dressed up as a
    // measurement, and it reads like a real observation about a real session.
    if (!p.beat) {
      console.log(`${'?'.padEnd(5)} ${label.padEnd(16)} malformed presence message - no beat field`);
      continue;
    }
    // Floor it: a Slack ts carries microseconds, so a raw subtraction renders as
    // "43.18815088272095s ago" - false precision on a number whose whole purpose is a
    // coarse alive/dead call.
    const age = Math.max(0, Math.floor(now - p.beat));
    const limit = Math.max((p.every || 60) * STALE_AFTER, STALE_FLOOR_SEC);
    const state = age > limit ? 'STALE' : 'alive';
    console.log(`${state.padEnd(5)} ${label.padEnd(16)} last beat ${age}s ago (every ${p.every}s)`);
  }
  for (const [label, age] of active) {
    const state = age <= STALE_FLOOR_SEC ? 'active' : 'STALE';
    console.log(
      `${state.padEnd(5)} ${label.padEnd(16)} no beat, but POSTED ${age}s ago` +
        (state === 'active' ? "  <- present, NOT reachable (cannot be --ping'd)" : ''),
    );
  }
  if (gone.length && !a.all) {
    console.log(`\n${gone.length} session(s) aged out after ${GONE_AFTER_SEC}s and are not listed: ${gone.map(([s]) => s).join(', ')}`);
    console.log('Pass --all to see them. They are omitted because a roster that never forgets becomes a graveyard.');
  }
  console.log('\nSTALE means the watcher stopped publishing - the session is gone, or its watcher died.');
  console.log('It does NOT prove the session is wedged, and alive does NOT prove it is responsive.');
  console.log('');
  console.log('active = the session POSTED recently but publishes NO BEAT. A message is STRONGER');
  console.log('evidence of life than a beat: a beat proves only that a timer fired, a message');
  console.log('proves the session ACTED. But active is NOT alive - it is PRESENT and NOT');
  console.log("REACHABLE: it cannot be --ping'd and will not answer a liveness probe.");
  console.log('DO NOT take an active session\'s claims on staleness grounds. Silence on a');
  console.log('heartbeat it never published is not evidence of anything.');
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

  /**
   * ★ NOT A LOSS - A LAG. The difference was settled by MEASUREMENT, not reasoning.
   *
   * The reported worry was that a burst larger than one page would be SKIPPED: take the
   * newest 50, advance the cursor past them, never see the older remainder. Tested
   * against the live API with `oldest` set and `limit=3`, and the premise is REFUTED -
   * Slack returns the OLDEST slice of the window, not the newest:
   *
   *     window held 57 messages, has_more=true
   *     limit=3 returned the three OLDEST, matching the window's first three exactly
   *
   * So walking `oldest` forward CANNOT skip: each poll takes the next-oldest page, and
   * the cursor never advances past a message that was not emitted. A backlog DRAINS over
   * successive polls rather than being lost.
   *
   * ⚠ What is left is real but different: the watcher is BEHIND, and was silently so. A
   * claim thread whose earliest claims - the ones that WIN under lowest-ts - are still
   * queued reads as unresolved until the drain catches up. Reporting is therefore enough;
   * draining is not needed, because nothing is gone.
   */
  if (res.has_more) {
    console.error(
      '[watch] a full page was waiting - this poll is BEHIND, not lossy. Slack returns the\n' +
        '        OLDEST slice of the window, so nothing is skipped and the backlog clears over\n' +
        '        the next polls. Lower --interval if the delay matters.',
    );
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

    // ⛔⛔ DO NOT "TIDY" THIS INTO `if (m.subtype) continue`.
    //
    // That is the near-universal Slack idiom for "is this a real user message", and it
    // would drop every broadcast on the floor: a reply posted with reply_broadcast
    // arrives with subtype=thread_broadcast. Claims and dones would silently vanish and
    // the symptom would be identical to the bug reply_broadcast exists to fix - tasks
    // appearing and never resolving.
    //
    // This is an EXCLUSION list on purpose. Be liberal in what you accept: the same
    // principle decides three outcomes in this skill - rendering unknown types as
    // !UNKNOWN rather than swallowing them, parsing every context element rather than a
    // whitelist, and excluding known subtypes rather than including known ones.
    if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue;

    const { meta, body, bareSeams } = parseMessage(m);
    // ⚠ SURFACED, NOT SWALLOWED - same rule as !UNKNOWN. The join is a guess at these
    // seams and nothing else on this line would say so. It is not a repair: those
    // separators are gone, and the marker only stops a guess being read as a reading.
    const seamWarn = bareSeams ? ` !JOINED(${bareSeams} seam${bareSeams > 1 ? 's' : ''} with no stored separator)` : '';
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
    // `reader=`, NOT `you=`. A SESSION DOES NOT HAVE A VERSION - A PROCESS DOES, and
    // one session routinely holds several at once: a long-lived watcher plus every
    // short-lived invocation beside it. `you=` implied a single answer existed and
    // made two correct processes look like one wrong instrument. Observed: the same
    // message rendered `2.8.1+dev` by a resident watcher and `2.9.0+dev` by a fresh
    // call, seconds apart. Neither was faulty; the QUESTION was ill-posed.
    //
    // ⚠ AND OWN_PLUGIN IS READ ONCE, AT MODULE LOAD (see the const above). In a CACHE
    // copy that is exact forever - the version is in the path and the files never
    // change. In a REPO checkout the number describes the manifest AT LAUNCH and not
    // the code, which is the whole reason `+dev` exists. So a `+dev` version is not a
    // stale reading of the code; it is not a reading of the code at all. Do not
    // re-read the manifest per message to "fix" this: it would make the process
    // report a version it is not running, which is strictly worse.
    else if (OWN_PLUGIN && meta.plugin !== OWN_PLUGIN) plugin = ` plugin=${meta.plugin}!SKEW(reader=${OWN_PLUGIN})`;

    // One line per message: each becomes a single Monitor event.
    console.log(`[bus] ts=${m.ts} from=${from}${to}${type}${thread}${plugin}${edited}${seamWarn} :: ${body.replace(/\s+/g, ' ')}`);
  }
  return true;
}

// Roster mode: report who is alive and exit. Not a watch.
if (a.presence) {
  await roster();
  process.exit(0);
}

/**
 * --retire: delete this session's presence message, so its label leaves the roster at
 * once instead of lingering as STALE until it ages out.
 *
 * ⚠ AN EXPLICIT COMMAND, BECAUSE SIGNAL HANDLERS DO NOT WORK HERE. On Windows SIGTERM is
 * not a POSIX signal - the process is terminated without a JS-visible event, so an exit
 * handler never runs. Measured: a watcher killed with SIGTERM left its presence message
 * untouched and printed nothing. A Monitor's TaskStop kills the same way, which is how
 * watchers usually die.
 *
 * So retirement is something a session DOES before stopping, not something it hopes will
 * happen on the way out - and AGE-OUT still carries the weight, because a crashed session
 * runs no commands at all.
 */
/**
 * --ping <session>: ask a peer whether it is actually there, and wait for an answer.
 *
 * ★★ THIS IS THE ONLY MECHANISM HERE THAT TESTS RESPONSIVENESS RATHER THAN INFERRING IT.
 * Presence proves a WATCHER PROCESS is running - §6 says plainly that a session wedged
 * behind a live watcher reads alive and nothing can tell you. A pong can, because it only
 * exists if the session WOKE AND ACTED.
 *
 * ⛔ THE PONG MUST COME FROM THE SESSION, NOT THE WATCHER. An auto-reply in the poller
 * would prove only that the poller is alive, which presence already tells you - it would
 * look like new evidence while carrying none. That is the single most repeated failure in
 * this whole design, and here it would be built in on purpose.
 *
 * ⚠ Silence still is not proof, and it has MORE causes than it looks:
 *
 *   1. the session does not exist
 *   2. it is dead, or mid-turn, or running no watcher
 *   3. IT IS ALIVE, WELL, AND CORRECTLY DECLINING - because §3 puts to: filtering on the
 *      reader, so a session obeying the addressing convention stays quiet
 *
 * Cause 3 is produced by the protocol WORKING, and it is why:
 *
 *   ⛔ A BROADCAST PING MEASURES NOTHING. Every correctly-filtering session stays silent
 *      and reads as dead. Ping ONE session BY NAME, and require that a named session
 *      answers UNCONDITIONALLY - a conditional answer makes silence meaningless again.
 */
if (a.ping) {
  const target = a.ping;
  const waitSec = Math.max(5, Number(a.wait) || 45);
  const sent = await slackPost('chat.postMessage', {
    channel: a.channel,
    text: `ping: ${target}`,
    blocks: [
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'type: `x-ping`' },
          { type: 'mrkdwn', text: `to: \`${target}\`` },
          { type: 'mrkdwn', text: `session: \`${selfLabel ?? 'unknown'}\`` },
          // ⚠ EVERY hand-built context block must carry this. A path that omits it makes
          // its messages read as `plugin=?`, which the degradation rule interprets as
          // "older than the version that started announcing" - a confident and WRONG
          // inference about a current sender. This block shipped without it.
          ...(OWN_PLUGIN ? [{ type: 'mrkdwn', text: `plugin: \`${OWN_PLUGIN}\`` }] : []),
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${target}, are you there?* Reply with \`--type x-pong\` if you are. ` +
            'No answer within the window is not proof of death - you may simply be mid-turn.',
        },
      },
    ],
  });
  if (!sent.ok) {
    console.error(`Could not send ping: ${sent.error}`);
    process.exit(2);
  }
  console.log(`Pinged "${target}" at ${sent.ts}. Waiting up to ${waitSec}s...`);

  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const look = await recentMessages(50);
    if (!look.ok) { console.error(`[ping] read failed (${look.error}) - still waiting; a missed read is not a missed pong.`); continue; }
    for (const m of look.messages) {
      if (Number(m.ts) <= Number(sent.ts)) continue;
      const mm = parseMessage(m).meta;
      if (mm.type === 'x-pong' && mm.session === target) {
        const rtt = (Number(m.ts) - Number(sent.ts)).toFixed(1);
        console.log(`PONG from "${target}" after ${rtt}s. It is awake and responsive.`);
        console.log('That is stronger than presence: presence proves a watcher runs, a pong');
        console.log('proves the SESSION woke and acted.');
        process.exit(0);
      }
    }
  }
  console.log(`No pong from "${target}" within ${waitSec}s. THIS IS NOT EVIDENCE OF ABSENCE.`);
  console.log('  - it may not exist');
  console.log('  - it may be dead, mid-turn, or running no watcher');
  console.log('  - it may be alive and well but not answering unconditionally, which is the');
  console.log('    one cause you would never guess: obeying the addressing convention looks');
  console.log('    identical to being dead.');
  console.log('Check --presence: beating + no pong is the wedged signature.');
  process.exit(1);
}

/**
 * --audit <thread-ts>: find replies that exist in a THREAD but not in the CHANNEL
 * TIMELINE - i.e. messages no watcher on this bus can ever see.
 *
 * ★★ WHY A FOURTH SURFACE IS NEEDED. --help and --dry-run describe INTENT: what you are
 * about to send. --raw describes REALITY - but it reads conversations.history, and a
 * NON-BROADCAST REPLY IS NOT IN HISTORY. So the inspector can confirm that a broadcast
 * happened and can NEVER show one that failed, because the failure mode is absence from
 * the very source it reads.
 *
 * That leaves this failure silent on every surface at once:
 *
 *   SILENT AT SEND     the poster returns a ts and exits 0
 *   SILENT AT RECEIVE  nothing arrives, and nothing arriving is normal
 *   INVISIBLE TO --raw the message is absent from the source the inspector reads
 *
 * The only way to detect it is to compare two views that no single command compared:
 * the thread, and the timeline. That is this.
 */
if (a.audit) {
  if (!/^\d{10,}\.\d{6}$/.test(a.audit)) {
    console.error(`--audit "${a.audit}" is not a Slack timestamp. Quote it.`);
    process.exit(2);
  }
  const rep = await fetch(
    `https://slack.com/api/conversations.replies?channel=${a.channel}&ts=${a.audit}&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());
  if (!rep.ok) {
    console.error(`Could not read the thread: ${rep.error}`);
    process.exit(2);
  }
  const replies = (rep.messages ?? []).filter((m) => m.ts !== a.audit);

  // ⚠ BOUND THE WINDOW BY THE THREAD'S OWN SPAN, NEVER BY A MESSAGE COUNT.
  //
  // A count-based window makes the VERDICT A FUNCTION OF CHANNEL VOLUME rather than of
  // the messages: a thread that audits correctly today reports its broadcast replies as
  // INVISIBLE once enough unrelated traffic pushes them out of the window. Same thread,
  // same facts, opposite answer, because the channel moved on - an instrument whose
  // output changes without its subject changing.
  //
  // Bounded by [parent ts, newest reply], the window is exactly the thread's lifetime and
  // the answer is STABLE FOREVER: audited today or next year, "was this reply in the
  // timeline" has one fixed answer. That REMOVES the caveat instead of documenting it,
  // which matters for a diagnostic - a tool whose disclaimer says "this may be wrong for
  // reasons unrelated to what you asked" stops being trusted exactly when it is needed.
  const newest = replies.reduce((mx, m) => (Number(m.ts) > Number(mx) ? m.ts : mx), a.audit);
  const timeline = new Set();
  let cur = null;
  let pages = 0;
  do {
    const u = new URL(HISTORY);
    u.searchParams.set('channel', a.channel);
    u.searchParams.set('oldest', a.audit);
    u.searchParams.set('latest', newest);
    u.searchParams.set('inclusive', 'true');
    u.searchParams.set('limit', '200');
    if (cur) u.searchParams.set('cursor', cur);
    const page = await fetch(u, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    if (!page.ok) {
      console.error(`Could not read the channel timeline: ${page.error}`);
      process.exit(2);
    }
    for (const m of page.messages ?? []) timeline.add(m.ts);
    cur = page.has_more ? page.response_metadata?.next_cursor : null;
    pages++;
  } while (cur && pages < 25);

  const invisible = replies.filter((m) => !timeline.has(m.ts));

  console.log(`Thread ${a.audit}: ${replies.length} repl(ies).`);
  for (const m of replies) {
    const { meta } = parseMessage(m);
    const seen = timeline.has(m.ts);
    console.log(`  ${seen ? 'visible  ' : 'INVISIBLE'} ${m.ts}  type=${meta.type ?? '?'} from=${meta.session ?? '?'}`);
  }
  if (invisible.length) {
    console.log('');
    console.log(`${invisible.length} repl(ies) are in the thread and NOT in the channel timeline.`);
    console.log('No watcher on this bus has seen them, or can. If any is a done or a fail, the');
    console.log('task looks permanently open to every peer. Repost it with --broadcast.');
  } else {
    console.log('');
    console.log('All replies are in the timeline: every watcher could have seen them.');
  }
  console.log(`(Compared over the thread's own span, ${a.audit} to ${newest}, across ${pages} page(s).`);
  console.log(' Bounded by the thread, not by channel volume, so this verdict does not change.)');
  process.exit(invisible.length ? 1 : 0);
}

if (a.retire) {
  if (!selfLabel) {
    console.error('--retire needs a label: pass --session, or set CLAUDE_SESSION_NAME.');
    process.exit(1);
  }

  // ★★ RETIREMENT IS POSITIVE EVIDENCE OF ABSENCE, AND IT IS THE ONLY SUCH SIGNAL ON THIS
  // BUS. Every other absence signal here is an inference from SILENCE, which is why §6 is
  // weak: silence is ambiguous between three states that need different responses.
  //
  //   FINISHED CLEANLY AND LEFT  -> its claims are free NOW
  //   DIED HOLDING A CLAIM       -> probably free, but wait out the timeout first
  //   ALIVE BUT WEDGED          -> NOT free, and nothing can tell you
  //
  // An earlier version implemented retirement as "delete the presence message", which
  // produces a state BYTE-IDENTICAL to having died - collapsing the first two, so every
  // takeover paid the full staleness timeout even when the holder had left a note saying
  // it was done. Announcing first is what makes the difference legible.
  //
  // Broadcast, because it changes what a peer should DO (a held claim just became free).
  const rel = (a.releases ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const elements = [
    { type: 'mrkdwn', text: 'type: `x-retired`' },
    { type: 'mrkdwn', text: `session: \`${selfLabel}\`` },
  ];
  if (rel.length) elements.push({ type: 'mrkdwn', text: `releases: \`${rel.join(' ')}\`` });
  if (OWN_PLUGIN) elements.push({ type: 'mrkdwn', text: `plugin: \`${OWN_PLUGIN}\`` });

  const announced = await slackPost('chat.postMessage', {
    channel: a.channel,
    text: `retired: ${selfLabel}`,
    reply_broadcast: true,
    blocks: [
      { type: 'context', elements },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: rel.length
            ? `Leaving cleanly and releasing ${rel.length} claim(s): \`${rel.join('`, `')}\`. ` +
              'These are free immediately - a taker does not need to wait out the staleness timeout.'
            : 'Leaving cleanly. No claims declared as held; anything I did hold should be treated as released.',
        },
      },
    ],
  });
  if (!announced.ok) console.error(`  could not announce retirement: ${announced.error}`);

  // Only NOW remove presence. The announcement is the durable record; presence is
  // ephemeral status and is what would otherwise linger as STALE.
  let removed = 0;
  const look = await recentMessages();
  if (!look.ok) console.error(`[retire] could not read the channel (${look.error}); the ANNOUNCEMENT is posted and is the durable record, but presence messages could not be removed and may linger as STALE.`);
  for (const m of look.messages) {
    const p = presenceOf(m);
    if (!p || p.session !== selfLabel) continue;
    const res = await slackPost('chat.delete', { channel: a.channel, ts: m.ts });
    if (res.ok) removed++;
    else console.error(`  could not delete ${m.ts}: ${res.error}`);
  }
  console.log(`Retired "${selfLabel}": announced${rel.length ? ` (releasing ${rel.length} claim(s))` : ''}, removed ${removed} presence message(s).`);
  console.log('Claims and dones stay in their threads: this discards STATUS, never history.');
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
/**
 * --doctor: work out whether this session is behind, and if so print the exact thing to
 * ask a human for.
 *
 * ★ WHY IT COMPARES CODE AND NOT VERSION NUMBERS. A docs-only release bumps the version
 * while changing no behaviour, so "you are on 2.2.1, 2.3.0 exists" would demand an update
 * that gains nothing - and, worse, a version match says nothing about a RESIDENT copy
 * that has been running since before the file changed. The version is a label; the bytes
 * are the capability. So: compare the bytes, and report the version only as context.
 *
 * ⛔ IT ASKS. IT DOES NOT ACT. Updating a plugin is the human's call, and a session that
 * updated itself on a peer's say-so would be the authorisation problem in §2 wearing a
 * maintenance hat.
 */
function readJson(p) {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
}

function sameCode(a1, b1) {
  try {
    const norm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    return norm(a1) === norm(b1);
  } catch {
    return null; // unknown, not "different"
  }
}

/**
 * How long ago the marketplace clone was last pulled, as a phrase fit to sit beside
 * a version number. Read from .git/FETCH_HEAD, which git rewrites on every fetch.
 *
 * Falls back to "age unknown" rather than to silence: an ABSENT age reads as no
 * caveat at all, which is precisely the failure being fixed. A caveat that
 * disappears when it cannot be computed is worse than useless, because the reader
 * cannot tell "fresh" from "could not tell".
 */
function cloneAge(dir) {
  for (const f of ['FETCH_HEAD', 'HEAD']) {
    try {
      const ms = Date.now() - statSync(join(dir, '.git', f)).mtimeMs;
      const mins = Math.round(ms / 60000);
      if (mins < 1) return 'fetched just now';
      if (mins < 90) return `fetched ${mins}m ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 48) return `fetched ${hrs}h ago`;
      return `fetched ${Math.round(hrs / 24)}d ago`;
    } catch {
      /* try the next marker */
    }
  }
  return 'age unknown';
}

function cmpVer(x, y) {
  const p = (v) => String(v).split('.').map(Number);
  const [a1, b1, c1] = p(x);
  const [a2, b2, c2] = p(y);
  return a1 - a2 || b1 - b2 || c1 - c2;
}

if (a.doctor) {
  const selfFile = fileURLToPath(import.meta.url);
  const skillDir = dirname(selfFile);
  const runningManifest = readJson(join(skillDir, '..', '..', '.claude-plugin', 'plugin.json'));
  const pluginName = runningManifest?.name ?? 'slack-as-claude';
  const runningVer = runningManifest?.version ?? 'unknown';
  const inCache = selfFile.includes(join('.claude', 'plugins', 'cache'));

  // ⚠ --doctor reported RUNNING / INSTALLED / AVAILABLE / PEERS and never said WHICH
  // WORKSPACE those peers were in. A session talking to the wrong workspace saw an empty
  // roster and a clean bill of health, which is the same "absence I never observed"
  // failure as a swallowed read - one field further out.
  const WS = await checkWorkspace(token, { enforce: false });
  console.log(`WORKSPACE  ${workspaceLine(WS)}`);
  if (WS.want && !WS.verified && WS.who.ok) {
    console.log('           ⛔ MISMATCH - slack-post and slack-claim will REFUSE to send from this repo.');
  }
  console.log(`RUNNING    ${pluginName} ${runningVer}   ${inCache ? '(installed copy)' : '(REPO checkout - authoring only)'}`);
  console.log(`           ${selfFile}`);

  // Installed: newest version directory in any marketplace cache for this plugin.
  const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache');
  let installed = null;
  try {
    for (const mkt of readdirSync(cacheRoot)) {
      const dir = join(cacheRoot, mkt, pluginName);
      if (!existsSync(dir)) continue;
      for (const v of readdirSync(dir)) {
        if (existsSync(join(dir, v, '.orphaned_at'))) continue;
        if (!installed || cmpVer(v, installed.version) > 0) {
          installed = { version: v, marketplace: mkt, watcher: join(dir, v, 'skills', basename(skillDir), 'slack-watch.mjs') };
        }
      }
    }
  } catch {
    /* no cache */
  }
  console.log(`INSTALLED  ${installed ? `${installed.version}   (marketplace: ${installed.marketplace})` : 'none found'}`);

  // Available: what the marketplace clone ON DISK currently offers.
  //
  // ⛔⛔ THIS IS A CACHE, AND IT IS AS OLD AS THE LAST PULL. It is NOT what the
  // marketplace offers - it is what it offered when someone last ran
  // `/plugin marketplace update`. A release can be committed, tagged and pushed
  // and this number will not move.
  //
  // ★ Demonstrated live: --doctor printed `AVAILABLE 2.8.1 ... UP TO DATE ... and
  // nothing newer is available` while v2.9.0 sat tagged and pushed on origin. The
  // instrument built to detect version skew was itself reporting a stale cache as
  // current - and reported it in the exact words that tell a reader to stop looking.
  //
  // SO THE AGE SHIPS NEXT TO THE NUMBER, ALWAYS. A figure that can be stale must
  // carry how stale it might be, or the reader has no way to discount it. This is
  // the same rule as `+dev` on a version and `!SKEW` on a peer: the surface has to
  // disclose its own uncertainty, because a confident number reads as a fresh one.
  const mktRoot = join(homedir(), '.claude', 'plugins', 'marketplaces');
  let available = null;
  try {
    for (const mkt of readdirSync(mktRoot)) {
      const m = readJson(join(mktRoot, mkt, 'plugins', pluginName, '.claude-plugin', 'plugin.json'));
      if (m?.version && (!available || cmpVer(m.version, available.version) > 0)) {
        available = { version: m.version, marketplace: mkt, fetched: cloneAge(join(mktRoot, mkt)) };
      }
    }
  } catch {
    /* no marketplaces */
  }
  console.log(
    `AVAILABLE  ${
      available
        ? `${available.version}   (marketplace: ${available.marketplace}, ${available.fetched})`
        : 'unknown - marketplace clone not found'
    }`,
  );

  // Peers, from the wire.
  // Count peers by SESSION, not by message. Messages arrive newest-first, so the first
  // sighting of a session is its most recent word: take that and ignore its history.
  // (An earlier version incremented a silent counter per MESSAGE, so one quiet peer
  // reported as "+18 not announcing" - a number that looks like a fleet.)
  // ⚠ PEERS AND --presence MUST NOT DISAGREE ABOUT THE SAME DATA. An earlier version
  // listed every label that had ever spoken, with no staleness filter, while --presence
  // filtered on it. Harmless with a handful of test fixtures; not harmless later, because
  // a channel ACCUMULATES DEAD SESSIONS PERMANENTLY - the peer list only ever grows, and
  // the one line you read to answer "what are my peers running" fills with corpses.
  // Two views of one dataset that disagree is the exact failure this skill keeps hitting.
  const read = await recentMessages();
  const readable = read.ok;
  const msgs = read.messages;
  const now = Math.floor(Date.now() / 1000);
  const live = new Map();
  for (const m of msgs) {
    const p = presenceOf(m);
    if (p && (!live.has(p.session) || live.get(p.session).beat < p.beat)) live.set(p.session, p);
  }
  const peers = new Map();
  for (const m of msgs) {
    const { meta } = parseMessage(m);
    if (!meta.session || meta.session === selfLabel || peers.has(meta.session)) continue;
    const pr = live.get(meta.session);
    // Aged out entirely - not a peer, not a corpse, just forgotten. Same threshold the
    // roster uses, because the two views must never disagree about who exists.
    //
    // ⚠ Age on LAST ACTIVITY, not just on a beat. A session that never published
    // presence has no beat to age, so a beat-only check would keep it forever - and a
    // one-off label that posted once and vanished is exactly what fills a graveyard.
    // msgs is newest-first and this is its first sighting, so m.ts is its last word.
    const lastSeen = Math.max(pr?.beat ?? 0, Number(m.ts) || 0);
    if (lastSeen && now - lastSeen > GONE_AFTER_SEC && !a.all) continue;
    const alive = pr ? now - pr.beat <= Math.max((pr.every || 60) * STALE_AFTER, STALE_FLOOR_SEC) : false;
    // ⚠ PEERS AND --presence MUST NOT DISAGREE, and for one release they did: --presence
    // learned to report a posting-but-not-beating session as `active` while THIS view
    // still filed it under stale/gone. PEERS is the surface that caused the wrong
    // instruction in the first place, so fixing only the other one fixed the wrong half.
    const spokeAge = Math.max(0, Math.round(now - (Number(m.ts) || 0)));
    const active = !alive && spokeAge <= STALE_FLOOR_SEC;
    peers.set(meta.session, {
      plugin: meta.plugin ?? null,
      alive,
      active,
      spokeAge,
      seen: !!pr,
      beatAge: pr ? Math.round(now - pr.beat) : null,
    });
  }
  /**
   * ⛔⛔ A PEER'S VERSION IS "AS OF ITS LAST BEAT", NEVER "NOW". SAY SO.
   *
   * This is the THIRD lag layer, and it is the one nobody had named:
   *
   *     repo     -> cache        lags until /plugin marketplace update
   *     cache    -> resident     lags until the watcher restarts
   *     resident -> ADVERTISED   lags until the peer's next HEARTBEAT
   *
   * PEERS reads the third. The presence message is rewritten on each beat, so what it
   * says is true of the moment that beat was written - and the interval is a number the
   * PEER chose and you cannot see.
   *
   * ★ Observed: this line reported `session-two=2.8.1` and a session concluded the peer
   * had not restarted. It HAD - onto 2.9.1, from the cache path, minutes earlier. The
   * read landed 44 SECONDS before that peer's next beat rewrote the message. Nobody
   * misread anything; the surface stated a past fact in the present tense. At
   * --heartbeat 300 the same wrong inference would have held for five minutes.
   *
   * Identical defect to AVAILABLE asserting a fact about the marketplace while knowing
   * only a fact about a local clone, and it takes the identical fix: RENDER THE AGE, so
   * the number arrives with its own expiry rather than looking current.
   */
  const fmt = ([s, v]) =>
    `${s}=${v.plugin ?? '?'}${v.beatAge === null ? '' : ` (as of its beat ${v.beatAge}s ago)`}`;
  const alive = [...peers].filter(([, v]) => v.alive);
  const acting = [...peers].filter(([, v]) => v.active);
  const dead = [...peers].filter(([, v]) => !v.alive && !v.active);
  console.log(
    `PEERS      ${!readable ? `UNREADABLE (${read.error}) - nothing was learned about any peer` : alive.length ? alive.map(fmt).join(', ') : 'none live'}`,
  );
  if (acting.length) {
    console.log(
      `           ACTIVE, not beating: ${acting
        .map(([s, v]) => `${s}=${v.plugin ?? '?'} (posted ${v.spokeAge}s ago)`)
        .join(', ')}`,
    );
    console.log("           ^ present but NOT reachable - cannot be --ping'd. NOT a takeover candidate.");
  }
  if (dead.length) console.log(`           (stale/gone: ${dead.map(([s]) => s).join(', ')})`);
  const quiet = alive.filter(([, v]) => !v.plugin).map(([s]) => s);
  if (quiet.length) console.log(`           not announcing a version, necessarily older: ${quiet.join(', ')}`);

  // Verdict, by BYTES not by version number.
  console.log('');
  const asks = [];

  /**
   * ⛔⛔ ARE *YOU* VISIBLE? THIS TOOL KNEW AND REPORTED AROUND IT.
   *
   * A session with a label but no heartbeat is INVISIBLE TO EVERY PEER: it cannot be
   * --ping'd, it is absent from --presence entirely, and a stale takeover of its claims
   * looks justified to anyone evaluating one. That is a correctness hazard, not cosmetics.
   *
   * ★ OBSERVED, and it is the sharpest self-indictment in this file: a session spent a
   * full day building and documenting liveness WHILE PUBLISHING NONE OF IT. Every watcher
   * it armed omitted --heartbeat. This very command had already printed its own label in
   * the dead list -
   *
   *     (stale/gone: session-one, roster-probe, retiree, ...)
   *
   * - in output that session read and quoted to a peer more than once, scanning the line
   * for PEERS and never once looking for ITSELF in it. The instrument was correct and
   * complete; the reader filtered it out. It took the peer to notice.
   *
   * ⚠ CHECKED FROM THE WIRE, NOT FROM THIS PROCESS'S FLAGS. --doctor is a short-lived
   * invocation that never beats, so its own heartbeatSec is always 0 and testing it would
   * fire on every run. The question is whether the LABEL is beating - which is a fact
   * about the resident watcher, and the only place it is recorded is the channel.
   */
  // ⛔ NEVER ADVISE FROM A FAILED READ. This block told a session with a healthy watcher
  // to arm a second one, because an invalid_auth rendered as "no presence message at all".
  // Advice derived from an unanswered question is worse than no advice: it is actionable.
  if (selfLabel && readable) {
    const mine = live.get(selfLabel);
    const fresh = mine ? now - mine.beat <= Math.max((mine.every || 60) * STALE_AFTER, STALE_FLOOR_SEC) : false;
    if (!fresh) {
      // ⚠ THIS TEXT WAS WRITTEN WITH A KNOWN EXPIRY AND THE EXPIRY HAS ARRIVED. In 2.9.3
      // it said flatly "Every peer sees you as GONE", which was true only because the
      // roster read beats alone. Now that a peer's roster also reads MESSAGES, a session
      // that is posting is seen as ACTIVE, and the flat version would be an overstatement
      // shipped by the very release that made it false. The two cases say different things.
      const spokeAge = Math.max(0, Math.round(now - lastSpokeAt(msgs, selfLabel)));
      const speaking = spokeAge <= STALE_FLOOR_SEC;
      asks.push(
        `YOU ARE NOT PUBLISHING PRESENCE as "${selfLabel}"${mine ? ` - last beat ${Math.round(now - mine.beat)}s ago, past its window` : ' - no presence message at all'}.\n` +
          (speaking
            ? `  You posted ${spokeAge}s ago, so peers on 2.10.0+ see you as ACTIVE - present, but\n` +
              '  NOT REACHABLE. Older peers see you as GONE outright. Either way you cannot be\n' +
              "  --ping'd and cannot answer a liveness probe."
            : '  Every peer sees you as GONE. You cannot be --ping\'d, you are absent from\n' +
              '  --presence, and a STALE TAKEOVER of any claim you hold will look justified to\n' +
              '  the session performing it.') +
          '\n  Arm a watcher with:  --session <label> --heartbeat 60',
      );
    }
  }

  if (available && installed && cmpVer(available.version, installed.version) > 0) {
    asks.push(`ASK THE HUMAN TO RUN:  /plugin marketplace update ${available.marketplace}\n  (installed ${installed.version}, available ${available.version})`);
  }
  /**
   * ⛔⛔⛔ RUNNING < INSTALLED IS DEFINITIVE, AND THIS CHECK DID NOT EXIST.
   *
   * --doctor printed, in adjacent lines:
   *
   *     RUNNING    slack-as-claude 2.10.1   (installed copy)
   *     INSTALLED  2.11.0
   *     UP TO DATE, AS FAR AS THIS CAN SEE.
   *
   * The contradiction was in its OWN OUTPUT, two lines above the verdict, and the
   * verdict did not look at it. Everything below this reasons about BYTES; nothing
   * compared the two version numbers it had already printed.
   *
   * ★ AND THE BYTE CHECK CANNOT COVER THIS, because it compares ONE FILE - the
   * watcher, which is the file this code happens to live in. slack-watch.mjs was
   * BYTE-IDENTICAL between 2.10.1 and 2.11.0 while slack-claim.mjs and slack-post.mjs
   * both changed. Two of three executables differed and the instrument reported no
   * change, correctly, about the only file it looked at.
   *
   * ⚠ THE HAZARD IS REAL, NOT COSMETIC: the release it said you did not need contained
   * the Step 0 guard, so a session was told it was current while running the claim path
   * with a live DOUBLE-EXECUTION defect.
   *
   * A version directory in the cache is immutable and its name IS its version, so this
   * needs no byte comparison and cannot be fooled by which file happens to be identical.
   */
  if (inCache && installed && cmpVer(runningVer, installed.version) < 0) {
    asks.push(
      `YOU ARE RUNNING AN OLDER INSTALLED COPY: ${runningVer}, while ${installed.version} is installed.\n` +
        '  This is definitive - it compares version directories, not bytes - and it holds\n' +
        '  even when the file you are executing is unchanged, because the OTHER scripts in\n' +
        '  the plugin may not be. Restart from the newer copy:\n' +
        `  node "${installed.watcher}" --channel ${a.channel} --session <label> --since <last ts you saw>\n` +
        '  ⚠ pass --since, or the restart silently drops anything posted during the handover.',
    );
  }

  /**
   * Compare EVERY script in the plugin, not just this one. Checking only the file the
   * checker lives in is why a two-of-three change read as no change at all.
   */
  if (inCache && installed && installed.version !== runningVer) {
    const runRoot = join(skillDir, '..');
    const insRoot = join(installed.watcher, '..', '..');
    const differing = [];
    try {
      for (const skill of readdirSync(insRoot)) {
        const d = join(insRoot, skill);
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          if (!f.endsWith('.mjs')) continue;
          const mine = join(runRoot, skill, f);
          if (!existsSync(mine)) { differing.push(`${skill}/${f} (absent in yours)`); continue; }
          if (sameCode(mine, join(d, f)) === false) differing.push(`${skill}/${f}`);
        }
      }
    } catch {
      /* best effort - the version check above is the load-bearing one */
    }
    if (differing.length) {
      asks.push(
        `SCRIPTS THAT DIFFER from the installed ${installed.version}: ${differing.join(', ')}\n` +
          '  Listed because "the watcher is unchanged" says nothing about the others, and\n' +
          '  a stale slack-claim is the one that can double-execute a finished task.',
      );
    }
  }

  if (installed && existsSync(installed.watcher)) {
    const same = sameCode(selfFile, installed.watcher);
    if (same === false && inCache) {
      asks.push(
        `RESTART THIS WATCHER from the installed copy - the running process is stale:\n` +
          `  node "${installed.watcher}" --channel ${a.channel} --session <label> --since <last ts you saw>\n` +
          `  ⚠ pass --since, or the restart silently drops anything posted during the handover.`,
      );
    } else if (same === false && !inCache) {
      // Running a repo checkout whose bytes differ from the release. Direction is not
      // knowable from bytes alone, but a working tree is normally AHEAD, not behind -
      // so do not tell the human to go fetch something. Tell them what is actually true.
      asks.push(
        `You are running an AUTHORING CHECKOUT whose code differs from the released ${installed.version}.\n` +
          `  That usually means uncommitted work, not a stale session. Nothing to fetch.\n` +
          `  Peers on the release cannot see anything you added here until it ships.`,
      );
    } else if (same === true && !inCache) {
      asks.push(`Switch to the installed copy - same code, but the repo is authoring-only:\n  ${installed.watcher}`);
    }
  }

  if (!readable) {
    console.log('');
    console.log(`⛔ THE CHANNEL READ FAILED (${read.error}). Everything above about PEERS is`);
    console.log('UNKNOWN, not empty, and no ACTION has been suggested from it - advice derived');
    console.log('from an unanswered question is worse than none, because it is actionable.');
    console.log('The version lines ARE still trustworthy: they come from disk, not from Slack.');
  } else if (!asks.length) {
    // ⛔ WAS: "...and nothing newer is available." THAT SENTENCE WAS A LIE THIS TOOL
    // COULD NOT DETECT. It asserts a fact about the MARKETPLACE while knowing only a
    // fact about a LOCAL CLONE, and it was printed verbatim while v2.9.0 sat tagged
    // and pushed on origin. The words told the reader to stop looking, which is the
    // most expensive thing a wrong status line can do.
    //
    // The claim is now scoped to what was actually checked, and the caveat is
    // UNCONDITIONAL - not shown only when the clone looks old, because "old" is
    // exactly the judgement this tool has already proved it cannot make.
    console.log('UP TO DATE, AS FAR AS THIS CAN SEE. Running code matches the newest INSTALLED copy,');
    console.log('and nothing newer is present in the marketplace clone ON DISK.');
    console.log(
      `⚠ That clone is a CACHE (${available?.fetched ?? 'age unknown'}). A release pushed since then is`,
    );
    console.log('invisible here. This tool cannot see origin. Run /plugin marketplace update to be sure.');
    console.log('Note a version DIFFERENCE alone would not have meant anything: a docs-only release bumps');
    console.log('the number without changing behaviour. This check compares bytes, not version strings.');
  } else {
    const behind = asks.some((x) => x.startsWith('ASK') || x.startsWith('RESTART'));
    console.log(behind ? 'THIS SESSION IS BEHIND, and cannot fix it itself - updating a plugin is the human\'s call.' : 'ACTION SUGGESTED:');
    if (behind) console.log('Paste this to them:\n\n  I am behind on the slack-as-claude plugin and need you to authorise catching up.');
    asks.forEach((x) => console.log(`  ${x.replace(/\n/g, '\n  ')}`));
  }
  if (!a.session) console.log('\n(Pass --session <label> so your own messages are not counted as peers.)');
  process.exit(0);
}

if (a.raw) {
  const read = await recentMessages(a.since ? 200 : 20);
  if (!read.ok) {
    console.error(`could not read the channel: ${read.error}`);
    console.error('⛔ This is NOT "0 messages". --raw is the INSPECTOR - it is reached for when');
    console.error('the rendering already looks wrong, so an empty channel is the single most');
    console.error('misleading answer it could give. Nothing was read.');
    process.exit(1);
  }
  const msgs = read.messages.slice().reverse();
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

  // NOTE: there is deliberately NO exit handler here. SIGTERM is not a POSIX signal on
  // Windows - the process dies without a JS-visible event, so a handler never runs, and
  // a Monitor's TaskStop kills the same way. Shipping a safeguard that silently never
  // fires is worse than shipping none: it invites everyone to rely on it. Retire with
  // the explicit --retire command, and rely on age-out for sessions that crash.
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
