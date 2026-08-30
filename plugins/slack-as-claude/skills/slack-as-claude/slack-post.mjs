#!/usr/bin/env node
/**
 * Post a Slack message as the app, labelled with where it came from.
 *
 *   node slack-post.mjs --channel C01234ABCDE --text "build green"
 *   node slack-post.mjs --channel C01234ABCDE --text "detail" --thread-ts 1788097923.905509
 *   node slack-post.mjs --channel C01234ABCDE --text "x" --dry-run
 *
 * Slack's MCP server (mcp.slack.com) is user-token-only, so anything sent through the
 * mcp__slack__* tools is attributed to the signed-in human with no "via app" marker.
 * This uses the app's BOT token against the plain Web API instead, so the message lands
 * under the app with an APP badge.
 *
 * The display name is left alone - Slack shows the app's own name and avatar - and all
 * the identifying detail goes in a context block, because a display name CLIPS silently
 * at ~50 visible characters while a context block WRAPS. See SKILL.md.
 *
 * Node 18+ only (global fetch, node:util parseArgs). No dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://slack.com/api/chat.postMessage';

/**
 * Which PLUGIN, at which version, produced this message - read from the plugin manifest
 * beside this script. Rendered as `plugin: slack-as-claude 2.2.1`.
 *
 * ⚠ Named in full rather than a bare `v:`, because on a bus a bare version number is
 * ambiguous: it could plausibly be the version of the repo being worked in, of Claude
 * itself, or of the editor extension. It is none of those - it is the version of the
 * SKILL PACKAGE that produced the message, and that is the only one that predicts what
 * the sender can and cannot do.
 *
 * ⚠ Emitted on every message because VERSION SKEW IS OTHERWISE UNDETECTABLE FROM THE
 * WIRE. Nothing else in the format says what a sender can do, so a peer meets a missing
 * capability and can only read it as a defect - which happened: a session measured, and
 * escalated, a feature that simply had not shipped to it yet.
 *
 * This is the same lesson as the authorisation rule in a different coat: DO NOT INFER A
 * PEER'S CAPABILITIES FROM ITS BEHAVIOUR. The peer should be telling you.
 */
function pluginVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = join(here, '..', '..', '.claude-plugin', 'plugin.json');
    if (!existsSync(manifest)) return null;
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!m.version) return null;

    // ⚠⚠ MARK AN AUTHORING TREE. A working checkout carries the version of the release
    // it is BASED on, not of the code it is running - so an unreleased file announces a
    // version that does not contain it. Both sides then report `2.4.1`, one has a script
    // the other has never seen, and the field REPORTS EQUAL WHILE MEANING UNEQUAL.
    //
    // That is worse than a mismatch: a mismatch prompts a check, and a match tells the
    // reader to stop checking, which is what a matching version is FOR.
    const released = here.includes(join('.claude', 'plugins', 'cache'));
    const suffix = released ? '' : '+dev';
    return `${m.name || 'plugin'} ${m.version}${suffix}`;
  } catch {
    /* a missing version is not worth failing a post over */
  }
  return null;
}

// --- token ------------------------------------------------------------------

function botToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;

  // Windows: `setx` writes to HKCU\Environment, but a running process keeps the
  // environment block it inherited at launch - so a token set after Claude Code
  // started is invisible to process.env while plainly existing. Read the registry.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Environment', '/v', 'SLACK_BOT_TOKEN'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const m = out.match(/SLACK_BOT_TOKEN\s+REG_(?:EXPAND_)?SZ\s+(\S+)/);
      if (m) return m[1];
    } catch {
      /* not set there either */
    }
  }
  return null;
}

// --- identity ---------------------------------------------------------------

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

function projectLabel() {
  const root = gitRoot();
  return basename(root || process.cwd());
}

function sessionLabel() {
  // A human label if one was set, otherwise the session's own id. Deliberately NOT
  // the git branch: a branch is shared by every session working on it, so it cannot
  // identify one. Claude Code exposes no session *title* - summaries are written on
  // compaction, not live - so the id is the only per-session handle that exists.
  if (process.env.CLAUDE_SESSION_NAME) return process.env.CLAUDE_SESSION_NAME;
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  return id ? id.slice(0, 8) : null;
}

function osLabel() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

function claudeUser(includeEmail) {
  // The Claude account behind the session. The email address is OPT-IN: every message
  // is visible to the whole channel, and a skill someone else installs must not stamp
  // their address into their workspace by default.
  let osUser = null;
  try {
    osUser = userInfo().username;
  } catch {
    osUser = process.env.USERNAME || process.env.USER || null;
  }

  const path = join(homedir(), '.claude.json');
  if (!existsSync(path)) return osUser;

  let name = null;
  let email = null;
  try {
    const acct = JSON.parse(readFileSync(path, 'utf8')).oauthAccount ?? {};
    name = acct.displayName || null;
    email = acct.emailAddress || null;
  } catch {
    return osUser;
  }

  if (!includeEmail) {
    // No display name and email withheld: the local part is the most that should be
    // shown by default. Better an ambiguous label than an unintended disclosure.
    return name || (email ? email.split('@')[0] : osUser);
  }
  if (name && email) return `${name} (${email})`;
  return name || email || osUser;
}

// --- args -------------------------------------------------------------------

const OPTIONS = {
    channel: { type: 'string' },
    text: { type: 'string' },
    'text-file': { type: 'string' },
    'thread-ts': { type: 'string' },
    broadcast: { type: 'boolean', default: false },
    'no-broadcast': { type: 'boolean', default: false },
    to: { type: 'string' },
    type: { type: 'string' },
    closes: { type: 'string' },
    project: { type: 'string' },
    user: { type: 'string' },
    machine: { type: 'string' },
    session: { type: 'string' },
    username: { type: 'string' },
    'icon-emoji': { type: 'string' },
    'user-email': { type: 'boolean', default: false },
    'no-context': { type: 'boolean', default: false },
    'unsafe-claim': { type: 'boolean', default: false },
    'as-app': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

const { values: a } = parseArgs({ options: OPTIONS, allowPositionals: false });

/**
 * Resolve the message body WITHOUT letting a shell touch it.
 *
 * ⛔⛔ --text ON A COMMAND LINE IS THE ONE CHANNEL GUARANTEED TO CORRUPT THE CONTENT THIS
 * BUS EXISTS TO CARRY. Backticks inside a double-quoted shell string are
 * command-substituted and VANISH; so do $, and quoting nests badly. The messages worth
 * sending here are the long ones with evidence in them - a code fragment, a ts, a diff -
 * and evidence is exactly the part that contains backticks.
 *
 * ★ So the failure PREFERENTIALLY DESTROYS PROOF AND LEAVES PROSE. A message that lost
 * its assertions still reads fluently, which is why it goes unnoticed. Observed: a
 * message arguing that an artefact contradicted its behaviour lost both of its evidence
 * passages and nothing else.
 *
 * ⚠ AND NO SURFACE HERE CAN CATCH IT. The substitution happens before node sees the
 * string, so no validation inside this script can detect it - and --dry-run prints the
 * ALREADY-MANGLED text, which looks correct because the missing part is missing from the
 * preview too. Four surfaces were built to tell the truth about a message; this
 * corruption is upstream of all of them.
 *
 * The only defence is not to hand the body to a shell at all.
 */
function resolveText() {
  if (a['text-file'] !== undefined) {
    if (a.text !== undefined) die('Pass --text OR --text-file, not both.', 2);
    if (a['text-file'] === '-') {
      try {
        return readFileSync(0, 'utf8');
      } catch {
        die('--text-file - was given but stdin was empty or unreadable.', 2);
      }
    }
    if (!existsSync(a['text-file'])) die(`--text-file: no such file: ${a['text-file']}`, 2);
    return readFileSync(a['text-file'], 'utf8');
  }
  return a.text;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const USAGE =
  'usage: node slack-post.mjs --channel <id> --text "..." [--thread-ts <ts>]\n' +
      '       [--text-file <path>] [--to X] [--type X] [--project X] [--session X]\n' +
      '       [--user X] [--machine X] [--closes <ts>] [--broadcast] [--no-broadcast]\n' +
      '       [--user-email] [--username X] [--icon-emoji :x:] [--unsafe-claim]\n' +
      '       [--no-context] [--as-app] [--dry-run] [--self-test]\n' +
      '\n' +
      '  --text-file <p> read the body from a FILE, or - for stdin, instead of --text.\n' +
      '                  USE THIS FOR ANYTHING CONTAINING CODE. Backticks in a double-\n' +
      '                  quoted shell string are command-substituted and VANISH before\n' +
      '                  this script runs, so nothing here can detect it and --dry-run\n' +
      '                  cannot either: it prints the already-mangled text, which reads\n' +
      '                  fine because the missing part is missing from the preview too.\n' +
      '  --unsafe-claim  permit --type claim from this tool. Normally REFUSED: posting a\n' +
      '                  claim does not win one, and slack-claim.mjs is what re-reads and\n' +
      '                  answers in its exit code. For doc examples and replays only.\n' +
      '  --self-test     check that every declared flag appears in this usage text.\n' +
      '  --to / --type   routing for a session bus, emitted as context elements so a\n' +
      '                  reader can parse them. Putting them in the body does not work.\n' +
      '                  type: request reply claim done fail status, or an x- prefix.\n' +
      '  --closes <ts>   which claim a done/fail discharges. Mirrors supersedes: on a\n' +
      '                  takeover - without it a thread records what was overridden\n' +
      '                  but not what was fulfilled.\n' +
      '  --broadcast     also place a threaded reply in the CHANNEL timeline, where a\n' +
      '                  poller can see it. AUTOMATIC for done/fail/claim in a thread.\n' +
      '  --no-broadcast  suppress that. A threaded reply no watcher can see is how a\n' +
      '                  finished task ends up looking permanently open.\n' +
      '  --thread-ts     QUOTE THE TIMESTAMP. Unquoted, a shell rounds it to a float and\n' +
      '                  Slack silently ignores the threading.';

/**
 * ⛔⛔⛔ EVERY DECLARED FLAG MUST APPEAR IN USAGE. AN INVARIANT, NOT A HABIT.
 *
 * FOUR flags shipped invisible before this existed: --replay, --closes, --broadcast
 * and --text-file. One caused a real protocol failure. After the second it was agreed
 * this should become mechanical, it did not, and the fourth shipped in the release
 * whose commit message was "Kill the shell-mangling class, and make the tool the
 * protocol". THE FEATURE BUILT TO STOP SILENT CORRUPTION SHIPPED SILENTLY INVISIBLE.
 *
 * Four occurrences is not carelessness, it is a MISSING CHECK. Usage is prose, flags
 * live in parseArgs, and nothing made them agree - so they drifted every single time.
 *
 * ⚠ AND THE AUDIT MEANT TO CATCH THIS GAVE A FALSE PASS. It grepped the WHOLE FILE for
 * /--[a-z-]+/ and matched --text-file in a comment and in an error message, then
 * reported "undocumented: none" about a flag that was undocumented. A check that
 * cannot tell DOCUMENTED from MERELY MENTIONED is the bug it is checking for, in a
 * hi-vis jacket. This one reads USAGE and nothing else.
 *
 * ★ Both of the edits that were supposed to add --text-file to usage were python
 * str.replace() calls whose anchor did not match. replace() returns the input
 * unchanged and raises NOTHING, so the script printed success twice and wrote a file
 * with no change in it. ASSERT THE ANCHOR, or verify the result afterwards.
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

if (a.help || !a.channel || (a.text === undefined && a['text-file'] === undefined)) {
  console.error(USAGE);
  process.exit(a.help ? 0 : 1);
}

// Resolved once, here, so every downstream use is the real body.
const TEXT = resolveText();

const token = botToken();
if (!token) {
  die(
    'SLACK_BOT_TOKEN is not set.\n' +
      (process.platform === 'win32'
        ? '  setx SLACK_BOT_TOKEN "xoxb-..."   (then restart, or it is read from the registry)'
        : '  export SLACK_BOT_TOKEN="xoxb-..."'),
  );
}

// --- payload ----------------------------------------------------------------

/**
 * Split a body across as many section blocks as it needs.
 *
 * ⚠ Slack caps a section's text at 3000 characters. Exceed it and the post fails with
 * `invalid_blocks` - an error that names blocks and says nothing about length, so the
 * cause is genuinely hard to guess. Observed on a long message over a session bus,
 * where the useful messages are exactly the long ones.
 *
 * Splitting beats refusing: prefer a paragraph break, then a line break, then a space,
 * so chunks land on natural boundaries rather than mid-word.
 */
const MAX_SECTION = 2900; // headroom under Slack's 3000
const MAX_BLOCKS = 48; // Slack allows 50; leave room for the context block

function sectionBlocks(text) {
  const chunks = [];
  let rest = text ?? '';
  while (rest.length > MAX_SECTION) {
    let cut = rest.lastIndexOf('\n\n', MAX_SECTION);
    if (cut < MAX_SECTION * 0.5) cut = rest.lastIndexOf('\n', MAX_SECTION);
    if (cut < MAX_SECTION * 0.5) cut = rest.lastIndexOf(' ', MAX_SECTION);
    if (cut <= 0) cut = MAX_SECTION;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  if (chunks.length > MAX_BLOCKS) {
    console.error(
      `Message is too long: it needs ${chunks.length} section blocks and Slack allows ${MAX_BLOCKS}.\n` +
        'Split it into separate messages, or post a summary and thread the detail.',
    );
    process.exit(1);
  }
  return chunks.map((c) => ({ type: 'section', text: { type: 'mrkdwn', text: c } }));
}

/**
 * The message types the session-bus protocol assigns meaning to.
 *
 * ⚠ These are validated rather than free-form because the claim protocol depends on
 * EXACT matches. A session posting `type: claims` has posted something no reader counts
 * as a claim - it sends fine, returns ok, and the session proceeds believing it claimed.
 * That is a correctness failure with a race behind it, and it is invisible.
 *
 * `x-` prefixed values pass unchecked, so extending the vocabulary stays possible and
 * a custom type is VISIBLY custom rather than indistinguishable from a typo.
 */
const KNOWN_TYPES = ['request', 'reply', 'claim', 'done', 'fail', 'status'];

/**
 * ⛔⛔ POSTING A CLAIM IS NOT WINNING A CLAIM - AND THIS IS THE TOOL THAT MAKES IT
 * LOOK LIKE IT IS.
 *
 * The protocol is post -> RE-READ the thread -> lowest ts wins -> losers stand
 * down. All of the safety is in the re-read. This tool does step one, prints a
 * cheerful success line, and does not do the other three - so it hands back
 * exactly the confirmation an agent needs to feel entitled to proceed, having
 * established nothing. Two sessions can both run it, both see "Posted", and both
 * start work.
 *
 * ★ THE PROTOCOL HAS ONLY EVER BEEN FOLLOWED BY SESSIONS THAT WERE TOLD TO FOLLOW
 * IT. Every test of it so far was run by an agent handed §4 in advance. An agent
 * that has NOT read §4 does not reach for slack-claim.mjs - it reaches for the
 * posting tool it already knows, with the type that matches the word it is
 * thinking. So THAT is the path that has to be safe, because it is the one taken
 * by default. A written rule binds only a reader; a refusal binds everyone.
 */
if (a.type === 'claim' && !a['unsafe-claim']) {
  die(
    'Refusing to post --type claim from the plain poster.\n' +
      '\n' +
      '  Posting a claim does not win it. The protocol is post -> RE-READ -> lowest\n' +
      '  ts wins -> losers stand down, and this tool only does the first step. It\n' +
      '  would print "Posted" and you would have established nothing: another\n' +
      '  session may hold the task already, with an earlier ts that outranks yours.\n' +
      '\n' +
      '  Use the tool that does all four steps and answers in its exit code:\n' +
      '      node slack-claim.mjs --channel <id> --task <thread-ts> --session <you>\n' +
      '      exit 0 = you hold it, proceed.  exit 1 = you do not, stand down.\n' +
      '\n' +
      '  If you are genuinely not claiming a task - a doc example, a replay, a test -\n' +
      '  pass --unsafe-claim and this posts verbatim.',
    2,
  );
}

if (a.type && !KNOWN_TYPES.includes(a.type) && !a.type.startsWith('x-')) {
  die(
    `Unknown --type "${a.type}".\n` +
      `  Known: ${KNOWN_TYPES.join(', ')}\n` +
      '  Use an x- prefix for a custom type (e.g. x-heartbeat).\n' +
      '  These are validated because the claim protocol matches on them exactly:\n' +
      '  a misspelled type posts successfully and is counted by nobody.',
  );
}

const payload = { channel: a.channel, text: TEXT };

if (a['thread-ts']) {
  // A Slack ts is 10+ digits, a dot, then exactly 6. Validate it, because the way this
  // goes wrong is invisible: in a shell that coerces the token to a float,
  // 1788097923.905509 rounds to 1788097923.90551. Slack then ignores the unknown
  // thread_ts, posts to the CHANNEL instead of the thread, and still returns ok:true.
  if (!/^\d{10,}\.\d{6}$/.test(a['thread-ts'])) {
    die(
      `--thread-ts "${a['thread-ts']}" is not a valid Slack timestamp (expected 1234567890.123456).\n` +
        'Quote it at the call site: an unquoted ts can be rounded to a float, and Slack\n' +
        'silently drops the threading rather than reporting an error.',
    );
  }
  payload.thread_ts = a['thread-ts'];

  // A threaded reply is NOT in the channel timeline, so conversations.history - and
  // therefore any cursor-based watcher - structurally cannot see it.
  //
  // ⛔ SO DECISION-CHANGING TYPES BROADCAST BY DEFAULT. Leaving this opt-in was a live
  // bug: slack-claim broadcast its claims, this path did not, and a `done` posted here
  // was invisible to every watcher on the bus. Exactly backwards - a claim says someone
  // MIGHT be working; a done says the task is OFF THE BOARD. The message that closes a
  // task was the one nobody received. It compounded with --closes, whose whole purpose
  // is audit, being emitted only through the invisible path.
  //
  // ★ And note HOW it survived: thread-blindness was found on the CLAIM path, fixed
  // there, and verified there. The done path shared the bug and was never re-tested.
  // A fix verified only on the path that reported the bug leaves its siblings broken.
  //
  // This is the push/pull rule made structural instead of documented: push what changes
  // what someone should DO (claim, done, fail); leave status and progress to be pulled.
  const DECISION_TYPES = ['done', 'fail', 'claim'];
  const decisionInThread = a['thread-ts'] && DECISION_TYPES.includes(a.type);
  if ((a.broadcast || decisionInThread) && !a['no-broadcast']) payload.reply_broadcast = true;
}

let contextLine = '';

if (!a['as-app']) {
  const project = a.project ?? projectLabel();
  const session = a.session ?? sessionLabel();
  const machine = a.machine ?? process.env.CLAUDE_SLACK_MACHINE ?? hostname();
  const wantEmail =
    a['user-email'] || ['1', 'true', 'yes'].includes((process.env.CLAUDE_SLACK_USER_EMAIL ?? '').toLowerCase());
  const user = a.user ?? claudeUser(wantEmail);

  // Overriding the display name or avatar is the ONLY path that needs the
  // chat:write.customize scope. The default overrides nothing.
  if (a.username) payload.username = a.username;
  if (a['icon-emoji']) payload.icon_emoji = a['icon-emoji'];

  // One element per facet, so Slack does the spacing rather than a separator
  // character. Identifiers are code-formatted; the human bits stay plain.
  const elements = [];
  // Routing first: a reader wants to know "is this for me, and what is it" before
  // it cares who sent it. These MUST be elements, not prose in the body - a parser
  // reads elements, and an earlier version that scanned the body happily lifted
  // "to:" out of an English sentence that merely discussed addressing.
  if (a.to) elements.push({ type: 'mrkdwn', text: `to: \`${a.to}\`` });
  if (a.type) elements.push({ type: 'mrkdwn', text: `type: \`${a.type}\`` });
  // --closes names the claim a done/fail discharges, mirroring `supersedes:` on a
  // takeover. Without it the audit trail is asymmetric: you can see what was OVERRIDDEN
  // but not what was FULFILLED. In an ordinary thread the answer is recoverable - lowest
  // ts, then done - but in a thread where a takeover happened it is NOT, and that is
  // precisely the thread where you need to know which claim actually did the work.
  if (a.closes) elements.push({ type: 'mrkdwn', text: `closes: \`${a.closes}\`` });
  if (project) elements.push({ type: 'mrkdwn', text: `project: \`${project}\`` });
  if (session) elements.push({ type: 'mrkdwn', text: `session: \`${session}\`` });
  if (user) elements.push({ type: 'mrkdwn', text: `user: ${user}` });
  if (machine) elements.push({ type: 'mrkdwn', text: `machine: ${machine}` });
  elements.push({ type: 'mrkdwn', text: `os: ${osLabel()}` });
  const plugin = pluginVersion();
  if (plugin) elements.push({ type: 'mrkdwn', text: `plugin: \`${plugin}\`` });

  contextLine = elements.map((e) => e.text).join('  ');

  // 'text' stays the raw message so push notifications and unfurls read correctly.
  if (!a['no-context'] && elements.length) {
    payload.blocks = [{ type: 'context', elements }, ...sectionBlocks(TEXT)];
  }
}

// --- send -------------------------------------------------------------------

if (a['dry-run']) {
  console.log('DRY RUN - nothing sent.');
  console.log(`  channel  : ${a.channel}`);
  console.log(`  username : ${payload.username ?? "(the app's own name)"}`);
  console.log(`  icon     : ${payload.icon_emoji ?? "(the app's own avatar)"}`);
  console.log(`  context  : ${payload.blocks ? contextLine : '(none)'}`);
  if (payload.thread_ts) {
    console.log(`  thread_ts: ${payload.thread_ts}`);
    // ⚠ A FIELD THAT CHANGES DELIVERY MUST BE VISIBLE IN EVERY SURFACE THAT CLAIMS TO
    // DESCRIBE THE MESSAGE - --help, --dry-run, and the raw inspector.
    //
    // reply_broadcast decides whether a threaded reply is visible to any poller at all,
    // and it was previously reported by NONE of them: absent from --help (which forced
    // readers onto the path without it), and absent here. A preview whose whole purpose
    // is "show me what you are about to send" was omitting the one field whose absence
    // is invisible in the result.
    const why = a['no-broadcast']
      ? 'no  (--no-broadcast: this reply will be INVISIBLE to every watcher)'
      : payload.reply_broadcast
        ? a.broadcast
          ? 'yes (--broadcast)'
          : `yes (automatic: type "${a.type}" in a thread changes what a peer should do)`
        : `no  (type "${a.type ?? 'none'}" is not decision-changing; it will be visible only in the thread)`;
    console.log(`  broadcast: ${why}`);
  }
  console.log(`  text     : ${TEXT}`);
  process.exit(0);
}

let res;
try {
  res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
} catch (err) {
  die(`Request to Slack failed: ${err.message}`);
}

if (!res.ok) {
  const hints = {
    not_in_channel: 'The bot is not a member of that channel. In Slack: /invite @<app display name>',
    channel_not_found: 'Unknown channel id. Resolve it with mcp__slack__slack_search_channels.',
    invalid_auth: 'The bot token is stale - someone reinstalled the app. Re-copy it and re-set SLACK_BOT_TOKEN.',
    token_revoked: 'The bot token was revoked. Re-copy it from OAuth & Permissions.',
    missing_scope: 'The app lacks a required scope. --username/--icon-emoji need chat:write.customize.',
  };
  console.error(`Slack rejected the post: ${res.error}`);
  if (hints[res.error]) console.error(hints[res.error]);
  process.exit(1);
}

const as = payload.username ? `as '${payload.username}'` : 'as the app';
console.log(`Posted to ${res.channel} ${as}${payload.blocks ? ` [${contextLine}]` : ''} - ts ${res.ts}`);
