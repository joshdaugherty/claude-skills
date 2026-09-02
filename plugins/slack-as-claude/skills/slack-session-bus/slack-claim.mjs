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
import { execFileSync, spawnSync } from 'node:child_process';
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

/**
 * ⚠ DEFAULTS TO 2, NOT 1. In this script exit 1 is a VERDICT ("you do not hold the
 * claim, stand down"), so a misuse must never borrow it - see the uncaughtException
 * note above. This existed only in slack-post.mjs, where 1 is an ordinary failure;
 * calling it here threw a ReferenceError and the misuse message never printed.
 */
function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

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

function envFromRegistry(name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(name + '\\s+REG_(?:EXPAND_)?SZ\\s+(\\S+)'));
    return m ? m[1] : null;
  } catch {
    return null; /* not there either */
  }
}

/**
 * ⛔ THE PRECEDENCE HAZARD - full note in slack-post.mjs. `process.env` wins, which is right
 * for an explicit override and wrong after a ROTATION, when the inherited value is the old
 * one and a restart is a silent no-op for any shell that still carries it.
 *
 * ⛔⛔ WITHDRAWN, 1 Sep 2026 - THE PARAGRAPH THAT WAS HERE WAS FALSE, AND IT SHIPPED IN 2.18.1.
 *
 * It claimed: "an auth failure surfaces as exit 1, which is indistinguishable from LOSING A
 * CLAIM, so a credential problem reads as stand down and the work silently does not happen."
 * That was written from plausibility, never run, and a peer amplified it to "the worst thing
 * either of us has turned up" before anybody spent the two seconds to check.
 *
 * ✅ MEASURED with a deliberately invalid token: EXIT 2, and it never reaches the claim logic
 * at all - checkWorkspace() refuses first, saying "an unanswered question is not a match.
 * Refusing rather than posting somewhere unverified."
 *
 * ★ Every exit(1) in this file is a VERDICT REACHED AFTER A SUCCESSFUL READ - already
 * resolved, held by a live claimant, stale holder without --takeover, or a lower ts winning.
 * threadClaims() exits 2 on a failed read, and livenessOf() returns `unknown` rather than
 * `absent`. THE SEPARATION THIS FILE NEEDED WAS ALREADY BUILT, TWICE, BY EARLIER FIXES.
 *
 * ⚠ The correction is kept rather than deleted because the FALSE version is instructive: a
 * consequence invented for a real defect is still an invention, and attaching it to a true
 * finding (the precedence hazard IS real) is what made it credible enough to ship and to be
 * escalated. VERIFY THE CONSEQUENCE SEPARATELY FROM THE CAUSE.
 *
 * ⛔ NEVER PRINT EITHER VALUE.
 */
function botToken() {
  const VAR = tokenVar();
  const fromEnv = process.env[VAR];
  const fromReg = envFromRegistry(VAR);
  if (fromEnv && fromReg && fromEnv !== fromReg) {
    console.error(
      // ⛔⛔ THIS STRING CARRIED THE FALSE CLAIM FOR ONE COMMIT AFTER IT WAS WITHDRAWN.
      // The doc comment above was corrected; this was not - so the tool asserted "exits 1"
      // and then exited 2, four lines apart, in the same run. Caught by a peer who ran it
      // rather than read it.
      //
      // ★ THE COMMENT IS READ BY WHOEVER EDITS THIS FILE. THE STRING IS READ BY EVERYONE
      // WHO RUNS IT. Fixing the first and not the second is the same defect as reviewing a
      // generator instead of generating: I corrected what I was looking at rather than what
      // the tool says.
      `[claim] ⚠ ${VAR} DIFFERS between this process's environment and HKCU\\Environment.\n` +
        '        The environment wins and is a SNAPSHOT from launch, so after a rotation it is\n' +
        '        the OLD value, and restarting does not help while the parent shell holds it.\n' +
        `        Relaunch with it unset:  env -u ${VAR} node <script> …`,
    );
  }
  return fromEnv || fromReg || null;
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

  /**
   * ⛔ GUARD PATHS MUST BE EXECUTED, NOT JUST WRITTEN.
   *
   * `--done --fail` called die() when die() existed only in slack-post.mjs. It threw a
   * ReferenceError and the misuse message never printed. NOTHING IN THE EXISTING CHECKS
   * COULD SEE IT: `node --check` passes, because an unbound identifier in call position
   * is a RUNTIME error, not a parse error; and the usage invariant passed, because both
   * flags were correctly documented. The invariant enforced DOCUMENTATION COVERAGE, and
   * the defect was in REACHABILITY.
   *
   * ⚠ A static sweep for "called but never bound" was tried first and rejected. Three
   * attempts still left a false positive, and a checker that cries wolf in a repo about
   * surfaces overstating what they know is the very failure being guarded against.
   * RUNNING the path cannot false-positive.
   *
   * These spawn this same file, so they exercise the real entry point rather than a
   * re-implementation of it - the distinction that let the original bug through.
   */
  const OK = ['--channel', 'C0123456789', '--task', '1788101338.332479', '--session', 'probe'];
  const guards = [
    { name: '--done --fail', args: [...OK, '--done', '--fail'], want: 'Pass --done OR --fail, not both.', code: 2 },
    { name: 'no arguments', args: [], want: 'usage: node slack-claim.mjs', code: 2 },
    { name: 'unquoted ts', args: ['--channel', 'C0123456789', '--task', '1788101338.33248', '--session', 'probe'], want: 'is not a Slack timestamp', code: 2 },
  ];
  for (const g of guards) {
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...g.args],
      { encoding: 'utf8', env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-selftest-not-a-real-token' } },
    );
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    check(`guard "${g.name}" explains itself`, out.includes(g.want), true);
    check(`guard "${g.name}" exits ${g.code}, no stack trace`, r.status === g.code && !/ReferenceError|TypeError|is not defined/.test(out), true);
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
    done: { type: 'boolean', default: false },
    fail: { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

/**
 * ⛔ An unknown flag threw a Node stack trace instead of naming the known ones. Full note in
 * slack-post.mjs. ⚠ Do NOT reference USAGE here - it is declared LATER in this file.
 *
 * ⛔⛔ EXIT 2, NEVER 1. In this script exit 1 is a VERDICT - "stand down, someone else holds
 * it" - so a mistyped flag exiting 1 would be indistinguishable from losing a claim, and the
 * work would silently not happen. That is the one place in this repo where a usage error and
 * a legitimate answer share an exit code if nobody is careful.
 */
let a;
try {
  ({ values: a } = parseArgs({ options: OPTIONS }));
} catch (e) {
  console.error(`${e.message}\n`);
  console.error(`known flags: ${Object.keys(OPTIONS).map((f) => `--${f}`).join(' ')}`);
  console.error('\nRun with --help for the full usage.');
  process.exit(2);
}

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
      '  --done/--fail  finish a task you hold. Posts the resolution AND fills closes:\n' +
      '                 from YOUR claim in the thread - the value this tool already has\n' +
      '                 and used to make you copy by hand. Refuses if you hold no claim,\n' +
      '                 or if the task is already resolved. Body from --note.\n' +
      '  --self-test    check the ranking rule, including the equal-ts tiebreak that this\n' +
      '                 transport cannot produce. Exits 0 all-pass, 1 on any failure.\n' +
      '\n' +
      '  QUOTE THE --task TIMESTAMP. A Slack ts has 16 significant digits; a shell that\n' +
  '  parses the bare token as a float rounds it, and Slack silently ignores it.';

if (a['self-test']) selfTest();

// ⚠ ARGUMENT VALIDATION BEFORE ANY I/O. This lived inside the --done branch, BELOW the
// workspace check, so a plain misuse made a network round trip and then died with a
// message about workspaces instead of about the misuse. Caught by the guard self-test
// added for issue #1 - which is the first time one of these tests has failed for a
// reason that was not the bug it was written for.
if (a.done && a.fail) die('Pass --done OR --fail, not both.');

if (a.help || !a.channel || !a.task || !label) {
  console.error(USAGE);
  process.exit(a.help ? 0 : 2);
}

if (!/^\d{10,}\.\d{6}$/.test(a.task)) {
  console.error(`--task "${a.task}" is not a Slack timestamp (expected 1234567890.123456). Quote it.`);
  process.exit(2);
}


// ⛔ AFTER ALL ARGUMENT VALIDATION, AND THAT ORDER IS THE POINT. A misuse must be
// answerable without a network round trip: when this sat above the checks, a bad --task
// made an API call and then failed with a message about workspaces instead of about the
// timestamp. Both regressions were caught by the guard self-test, not by review.
//
// The claim protocol is worthless across a workspace boundary: a claim posted to the
// wrong workspace is invisible to every peer, so the claimant reads an empty thread and
// concludes it holds the task. Verified before any claim is written.
if (!a.help) await checkWorkspace(botToken() ?? '');

const token = botToken();
if (!token) {
  console.error(`${tokenVar()} is not set.`);
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
  /**
   * ⛔⛔⛔ THE MOST DANGEROUS MISSING CHECK IN THIS FILE, AND IT WAS MISSING.
   *
   * This is STEP 0 - "is the task already resolved?" - the check §4 calls the only
   * defence against claiming work that is already finished. Without the guard below,
   * a failed read (`res.messages` undefined) fell through `?? []` and returned NO
   * RESOLUTIONS, which is indistinguishable from a genuinely open task. The caller
   * then claimed and executed work that was already DONE.
   *
   * ⚠ THAT IS DOUBLE EXECUTION - the single outcome this protocol exists to prevent -
   * produced by the check written to prevent it, silently, with every surface
   * reporting success.
   *
   * ★ AND IT FAILS IN THE DIRECTION THAT ACTS. An empty result means "go ahead". A
   * rate limit is not an unlucky one-process event either: 429 is a property of the
   * CHANNEL, so it hits every contender at once, by definition. The more concurrency,
   * the likelier it fires - and concurrency is exactly when a stale "nothing here yet"
   * is most expensive.
   *
   * The two other reads in this file already exit 2 on !ok. This one did not, and
   * nothing distinguished it: same api(), same shape, one missing guard.
   */
  if (!res.ok) {
    console.error(`ERROR (not a verdict): could not check whether this task is resolved: ${res.error}`);
    console.error('Exit 2 = the question was not answered. Proceeding would risk claiming a task');
    console.error('that is ALREADY DONE, because an unread thread and an unresolved one look');
    console.error('identical from here. UNKNOWN MUST NOT RENDER AS OPEN.');
    process.exit(2);
  }
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
  // A failed read is NOT "no retirement". Both land on null, and that conflation is
  // fail-safe here - no retirement means no AUTOMATIC takeover - so the null stays.
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
  // ⚠ A FAILED READ IS NOT AN ABSENT HEARTBEAT. Returning null for both made the caller
  // announce "that session publishes no heartbeat" - a claim about the PEER - when all
  // that had happened was that this process could not ask. Fail-safe either way, since
  // the caller stands down; but a wrong REASON in a thread is what §4 relies on later.
  if (!res.ok) return { unknown: true };
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

/**
 * ★★★ FINISH THE TASK, AND FILL `closes:` FROM THE CLAIM THIS TOOL ALREADY HOLDS.
 *
 * `--closes` names the CLAIM a done discharges. The correct value was buried in this
 * script's output and had to be captured by hand, while the WRONG value - the task ts -
 * was already in the caller's hand as --thread-ts. The ergonomics pushed at the useless
 * one, and it showed: in an 8-agent run FIVE OF SIX dones carried the task ts.
 *
 * ⚠ Guarding that in slack-post fixed the lie and created a gap: the wrong default was
 * removed without a right one being supplied, so the path of least resistance became
 * OMITTING closes entirely. Measured, against the author, within sixty seconds of the
 * guard shipping - the very next done posted had no closes: at all.
 *
 * ★ SO THE FIX IS NOT A BETTER WARNING, IT IS NOT MAKING THE HUMAN CARRY THE VALUE.
 * The tool knows which claim is yours; requiring you to copy it was the defect.
 */
if (a.done || a.fail) {
  
  const kind = a.done ? 'done' : 'fail';
  const replies = await threadClaims();
  const mine = replies.filter((c) => c.session === label).sort((x, y) => (x.ts < y.ts ? -1 : 1))[0];
  if (!mine) {
    console.error(`ERROR (not a verdict): you have no claim in this thread as "${label}".`);
    console.error('A done must discharge a claim. Claim it first, or check --session.');
    process.exit(2);
  }
  const already = await resolutions();
  if (already.length) {
    console.error(`ERROR (not a verdict): this task is ALREADY resolved - ${already[0].session ?? '?'} posted ${already[0].type} at ${already[0].ts}.`);
    console.error('A second resolution would make the thread ambiguous about which one counts.');
    process.exit(2);
  }
  const els = [
    { type: 'mrkdwn', text: `type: \`${kind}\`` },
    { type: 'mrkdwn', text: `session: \`${label}\`` },
    { type: 'mrkdwn', text: `closes: \`${mine.ts}\`` },
  ];
  const pl = ownPlugin();
  if (pl) els.push({ type: 'mrkdwn', text: `plugin: \`${pl}\`` });
  const body = a.note || `${label} finished this task.`;
  const res = await fetch(POST, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      channel: a.channel,
      thread_ts: a.task,
      reply_broadcast: true, // a resolution no watcher can see is how a task looks permanently open
      text: body,
      blocks: [{ type: 'context', elements: els }, { type: 'section', text: { type: 'mrkdwn', text: body } }],
    }),
  }).then((r) => r.json());
  if (!res.ok) {
    console.error(`ERROR (not a verdict): could not post the ${kind}: ${res.error}`);
    process.exit(2);
  }
  console.log(`Posted ${kind} at ${res.ts}, closing your claim ${mine.ts}.`);
  console.log('closes: was filled from the thread, not from you - which is the point.');
  process.exit(0);
}

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
  const state = live?.unknown
    ? 'liveness UNREADABLE - the API call failed, which is not a fact about that session'
    : !live
      ? 'no presence published'
      : live.alive
        ? `alive, last beat ${live.age}s ago`
        : `STALE, last beat ${live.age}s ago`;
  if (live?.alive || a['ignore-stale'] || !live || live.unknown) {
    console.log(`HELD BY ${holder.session} (claim ${holder.ts}) - ${state}.`);
    if (live?.unknown) console.log('The liveness read FAILED. That is not a statement about that session - treating the claim as held, which is the safe direction.');
  else if (!live) console.log('That session publishes no heartbeat, so its liveness is unknown. Treating the claim as held.');
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
