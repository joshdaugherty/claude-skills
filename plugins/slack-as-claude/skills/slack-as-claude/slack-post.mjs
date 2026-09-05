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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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

/**
 * The coordinator role's own token variable, resolved the same way tokenVar() resolves the
 * ordinary one - a SEPARATE Slack app/bot token, declared via `coordinator_token_env` in
 * slack-workspace.json, defaulting to SLACK_COORDINATOR_BOT_TOKEN. (#165)
 *
 * ⚠ THIS IS DELIBERATELY A SIBLING, NOT A PARAMETERISED tokenVar(). tokenVar() has exactly
 * one caller-facing meaning ("the token this repo posts as"); a coordinator token is a
 * DIFFERENT credential for a different role, not an alternate value of the same setting - the
 * two must never silently fall back to each other.
 */
function coordinatorTokenVar() {
  try {
    return repoWorkspace()?.coordinator_token_env || 'SLACK_COORDINATOR_BOT_TOKEN';
  } catch {
    return 'SLACK_COORDINATOR_BOT_TOKEN';
  }
}

/**
 * Read a user environment variable that may have been set AFTER this process launched.
 *
 * ⚠ Windows `setx` writes to HKCU\Environment, but a running process keeps the environment
 * block it inherited at launch - so a variable set after Claude Code started is invisible
 * to process.env while plainly existing. This reads it anyway.
 *
 * ⛔⛔ THIS EXISTED, WAS ALREADY GENERIC, AND WAS REACHABLE FROM EXACTLY ONE PLACE. It sat
 * inlined in botToken(), so a freshly-set TOKEN worked immediately while every freshly-set
 * IDENTITY variable silently did not. Two sessions on one machine then announced DIFFERENT
 * `machine:` values - one reading the alias, the other still reporting the raw hostname
 * because it had launched first. Neither was wrong; nothing reported the disagreement.
 *
 * ★ The generalisation cost was one `export`-shaped edit: the parameterised version already
 * existed because `token_env` forced it. A capability confined to the one caller that
 * happened to need it first is the same shape as the knowledge this project keeps finding
 * one line from where it was needed.
 */
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
    return null; /* not set there either */
  }
}

/**
 * ⛔⛔⛔ THE PRECEDENCE HAZARD: `process.env` WINS, AND IT CAN BE A STALE SNAPSHOT.
 *
 * Environment-first is RIGHT for the ordinary case - an explicit `VAR=x node …` override
 * must beat the persistent store, and taking that away would be a worse bug. But after a
 * credential ROTATION the two disagree, and the inherited value is the OLD one:
 *
 *   shell WITHOUT the variable   child reads the registry, gets the new value   ✔ restart works
 *   shell WITH the old value     child inherits it, registry never consulted    ⛔ restart is a NO-OP
 *
 * ⚠⚠ AND THE SECOND CASE IS THE DANGEROUS ONE, BECAUSE IT IS A REMEDY THAT REPORTS SUCCESS.
 * "Restart your watcher" is sound advice that silently does nothing for exactly the peer who
 * has already taken the corrective action and believes it worked. The process starts, the
 * token is accepted or refused for reasons that look unrelated, and nothing anywhere says
 * the two sources disagreed.
 *
 * ★ So this does not GUESS which is authoritative - it says that they differ, which is the
 * one fact neither source can report alone. Silent precedence is what turned a rotation into
 * a mystery; a loud one costs a line and cannot be misread.
 *
 * ⛔ NEVER PRINT EITHER VALUE, NOT EVEN A PREFIX. A leaked token is what started this.
 */
/**
 * The "no token" message, as a PURE FUNCTION OF (variable, platform).
 *
 * ⛔⛔ IT IS A FUNCTION SO THE BRANCH THIS AUTHOR CANNOT RUN CAN STILL BE TESTED. The bug it
 * replaces: the win32 arm interpolated the resolved variable and the other arm was a plain
 * string with SLACK_BOT_TOKEN baked in - so on macOS, a repo declaring its own `token_env`
 * got a correct, specific diagnosis followed by a remedy naming A DIFFERENT VARIABLE. The
 * reader exports it, nothing changes, and the same error repeats verbatim.
 *
 * ⚠ THE DIAGNOSIS BEING RIGHT IS WHAT MADE THE REMEDY CREDIBLE - the class this project
 * already named: review reads conditions, only firing reads output.
 *
 * ★★★ AND THE DEFECT DATES ITSELF: the branch that had been RUN substituted correctly, the
 * branch that had not, did not.
 *
 *     A PLATFORM-CONDITIONAL BRANCH IS ONLY EVER AS GOOD AS THE PLATFORM IT WAS RUN ON.
 *
 * Which generalises past platforms to ANY branch gated on an environment the author does not
 * have: untested BY CONSTRUCTION, not by oversight. Inlining it in a ternary made that
 * permanent; taking the platform as an ARGUMENT makes both arms reachable from a test on
 * either machine, which is the only fix that survives the next edit.
 *
 * ⚠ It lands hardest on the newer path, too: `token_env` exists so one machine can hold
 * several workspaces' tokens - so anyone who sees this message is, by construction, someone
 * for whom the default is wrong.
 */
function missingTokenMessage(varName, platform) {
  return (
    `${varName} is not set.\n` +
    (platform === 'win32'
      ? `  setx ${varName} "xoxb-..."   (then restart, or it is read from the registry)`
      : `  export ${varName}="xoxb-..."   in your shell profile, then EITHER:\n` +
        `    wrap the call:   bash -lc 'node <this script> ...'      <- measured working on macOS\n` +
        '    or restart the session -- ONLY if your editor was launched FROM A TERMINAL.\n' +
        '  A GUI-launched editor inherits from launchd, not from any shell, so no restart\n' +
        '  reaches it and you will see this exact message again.')
  );
}

function botToken(VAR = tokenVar()) {
  const fromEnv = process.env[VAR];
  const fromReg = envFromRegistry(VAR);
  if (fromEnv && fromReg && fromEnv !== fromReg) {
    console.error(
      `[post] ⚠ ${VAR} DIFFERS between this process's environment and HKCU\\Environment.\n` +
        '        The environment wins, and it is a SNAPSHOT taken when this process\n' +
        '        launched - so after a rotation it is the OLD value, and restarting does\n' +
        '        NOT help while the parent shell still carries it.\n' +
        '        If you have just rotated: relaunch with the variable unset, in whichever\n' +
        '        shell you are in - MEASURED: this also fires in Git Bash, where `env -u`\n' +
        '        works and neither remedy below does:\n' +
        `          Git Bash  :  env -u ${VAR} node <script> …\n` +
        `          PowerShell:  Remove-Item Env:\\${VAR} ; node <script> …\n` +
        `          cmd.exe   :  set ${VAR}= && node <script> …\n` +
        '        Simplest: open a fresh shell, which re-reads the registry.',
    );
  }
  return fromEnv || fromReg || null;
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

/**
 * The root of the MAIN worktree, which is the repo - not whichever worktree you
 * happen to be standing in.
 *
 * ⚠⚠ A LINKED WORKTREE MADE ONE REPO READ AS THREE PROJECTS. `--show-toplevel` returns
 * the WORKTREE directory, so a repo with a primary plus two fixed slots announced itself
 * as `repo`, `repo-a` and `repo-b` from the same codebase - to a peer routing on
 * `project:`, three unrelated projects. Reported from real use, and worked around at the
 * call site with --project before it was fixed here.
 *
 * ⛔ AND `--git-common-dir` ALONE IS NOT THE FIX - IT IS A SECOND BUG. It returns a
 * path RELATIVE TO THE CWD in the main worktree (`.git` at the root, `../.git` one level
 * down), so dirname() of it yields `..` and the project label becomes literally "..".
 * MEASURED, from a subdirectory of a real repo, before writing this.
 *
 * Resolving it against --show-toplevel fixes that on EVERY git version: a linked
 * worktree's common dir comes back absolute (resolve() then ignores the base), and the
 * main worktree's relative one resolves against its own root rather than the cwd.
 * `--path-format=absolute` would also work but needs git >= 2.31.
 */
function mainWorktreeRoot() {
  const top = gitRoot();
  if (!top) return null;
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: top,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return top;
    return dirname(resolve(top, common));
  } catch {
    return top;
  }
}

function projectLabel() {
  return basename(mainWorktreeRoot() || gitRoot() || process.cwd());
}

/**
 * The worktree slot, when you are standing in a linked one - `null` in the main worktree.
 *
 * ★ The slot name is genuinely useful ("which lane posted this"), it just must not be the
 * field peers FILTER on. So it gets its own facet instead of being folded into `project:`,
 * and the reader parses context elements with a generic key regex, so this is additive:
 * nothing that predates it breaks on seeing it.
 */
function worktreeLabel() {
  const top = gitRoot();
  if (!top) return null;
  const main = mainWorktreeRoot();
  return main && resolve(main) !== resolve(top) ? basename(top) : null;
}

function sessionLabel() {
  // A human label if one was set, otherwise the session's own id. Deliberately NOT
  // the git branch: a branch is shared by every session working on it, so it cannot
  // identify one. Claude Code exposes no session *title* - summaries are written on
  // compaction, not live - so the id is the only per-session handle that exists.
  /**
   * ⛔⛔⛔ NO `envFromRegistry` HERE, DELIBERATELY. A MACHINE-SCOPED STORE CANNOT EXPRESS A
   * PER-SESSION VALUE.
   *
   * `CLAUDE_SLACK_MACHINE` and `CLAUDE_SLACK_USER_EMAIL` are LABELS - one value per machine
   * is the correct model, so `HKCU\Environment` is the right home for them and #29 wired the
   * registry read there. `CLAUDE_SESSION_NAME` is an IDENTITY - MANY per machine - so a
   * machine-scoped store is not merely unnecessary, it is the WRONG SHAPE.
   *
   * ⚠ 2.18.3 through 2.18.8 wired it anyway, and the failure direction is the quiet one: a
   * session that omitted `--session` silently resolved its label out of the registry, and the
   * result LOOKS DELIBERATE RATHER THAN DEFAULTED - nothing in the output distinguishes "the
   * operator set this" from "this machine had one lying around". Two lanes can then land on
   * one label, and #24 records what follows: beat() adopts any presence matching it, roster()
   * keys by it, so two live sessions share one row that is addressable as neither.
   *
   * ★★★ AND THE REASON IT SHIPPED IS WORTH MORE THAN THE FIX. #29's issue BODY asked for all
   * three variables. A COMMENT four minutes later corrected it to exclude this one, citing the
   * SKILL.md shipped three hours earlier that calls the variable structurally unfit for what
   * it names. The body was implemented and the comment was never read.
   *
   *     A REQUIREMENT HAS REVISIONS, AND THE FIRST ONE IS THE ONE YOU ALREADY HAVE OPEN.
   *
   * The mirror of #61, which was "a ticket edit is not an input to the code": there the
   * correction came after the code, here it came BEFORE and was still missed. Read the
   * comments, not only the body.
   */
  const named = process.env.CLAUDE_SESSION_NAME;
  if (named) return { label: named, defaulted: false };
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  // ⚠ defaulted: true is what lets the caller mark this the way --doctor already marks the
  // identical fallback ("that is the session-id fallback rather than a label you use") - the
  // comment above this function already names the exact failure mode of NOT distinguishing
  // this from a chosen label; this is that distinction reaching the value itself. (#203)
  return { label: id ? id.slice(0, 8) : null, defaulted: Boolean(id) };
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
 *
 * ★ Three more OPTIONAL keys, for the coordinator role (#165, #173): `coordinator_token_env`
 * names the env var holding a SECOND, distinct bot token, the same way `token_env` names the
 * first. `coordinator_bot_id` and `coordinator_user_id` are that token's `bot_id`/`user_id`
 * (both from `--whoami --as-coordinator`) - IDENTIFIERS, not credentials, safe to commit here
 * exactly like `team_id` is. `coordinator_bot_id` is what `verifyBotId()` checks a message
 * against; `coordinator_user_id` is what a channel-membership check (`--member`,
 * slack-watch.mjs) looks for, since conversations.members returns user ids, not bot ids. None
 * of the three keys are validated by this function itself - the send path validates
 * `coordinator_bot_id` at the two `--as-coordinator` call sites below (absent, then wrong).
 * ⚠ THE TWO FAILURES ARE NOT SYMMETRIC. Absent fails safe: a real directive reads as
 * `unconfigured`, never a false positive. Wrong fails UNSAFE: `verifyBotId()` resolves it
 * to `forged`, the same rendering as an actual impersonation attempt, on a message the
 * real coordinator sent - which is why the send path warns on both, not just absence. (#184)
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

/**
 * ⛔⛔ ONE LINE NAMING WHERE TOKEN-NAME RESOLUTION ACTUALLY LOOKED - MISSING FROM EVERY
 * SURFACE THAT ACTS ON THE RESULT WITHOUT SHOWING checkWorkspace()'s FULLER VERDICT.
 *
 * A caller was told only the DOWNSTREAM symptom of a wrong resolution, never WHERE the
 * lookup went: a bare "SLACK_BOT_TOKEN is not set" naming the DEFAULT while a repo's own
 * declared token_env sat unset and unmentioned; a Slack channel_not_found for a channel
 * that exists, just not in the workspace this token actually belongs to (the registry
 * fallback resolving a DIFFERENT, real workspace's token on Windows); a plausible-looking
 * empty read with nothing to say it was reading the wrong place at all. None of the three
 * name the working directory, which is the cause in every one. (#222)
 *
 * Injectable so this is checkable without touching the real filesystem or shelling out to
 * git - see rtCases in selfTest().
 */
function resolutionTrace(varName = tokenVar(), root = gitRoot(), exists = existsSync) {
  if (!root) return `no git root found from ${process.cwd()} - falling back to ${varName}`;
  const p = join(root, '.claude', 'slack-workspace.json');
  return exists(p) ? `bound to ${p} (token_env: ${varName})` : `${p} not found - falling back to ${varName}`;
}

/** Who does this token actually belong to? One call, and it is the only source of truth. */
async function whoAmI(token) {
  try {
    const j = await (
      await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    ).json();
    return j.ok
      ? { ok: true, team: j.team, team_id: j.team_id, url: j.url, bot_id: j.bot_id, user_id: j.user_id }
      : { ok: false, error: j.error };
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
        `  Fix whichever is wrong: point ${tokenVar()} at the expected workspace, or\n` +
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
  /**
   * ⛔⛔ TWO DIFFERENT STATES RENDERED AS ONE VERDICT, AND THE HIDDEN ONE PICKS A DIFFERENT
   * WORKSPACE.
   *
   * `[no repo declaration - unenforced]` was emitted both when a git root exists and simply
   * declares nothing - the documented default - AND when THERE IS NO GIT ROOT AT ALL, so the
   * question was never asked. On a machine holding more than one workspace token the second
   * silently falls back to SLACK_BOT_TOKEN and selects a DIFFERENT DESTINATION, rendered as
   * clean output.
   *
   * ⚠ AND IT IS REACHABLE BY THE DOCUMENTED PATH, WHICH IS WHY IT IS NOT AN EDGE CASE: the
   * skill header hands the reader the plugin's own directory, §0 tells them to run a
   * --dry-run as its first act, and `cd`-ing to the script just named lands exactly here.
   * MEASURED on a released copy - same command, same channel, only cwd differing, two
   * different workspaces, both reported as fine.
   */
  if (!want) {
    return gitRoot()
      ? `${base}  [no repo declaration - unenforced]`
      : `${base}  ⛔ [NO GIT ROOT HERE - nothing was consulted, so this is whatever ${tokenVar()} points at]`;
  }
  return `${base}  [${verified ? 'matches' : 'DOES NOT MATCH'} ${want.path}]`;
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
    re: { type: 'string' },
    released: { type: 'string' },
    'cut-at': { type: 'string' },
    project: { type: 'string' },
    worktree: { type: 'string' },
    'raw-markdown': { type: 'boolean', default: false },
    user: { type: 'string' },
    machine: { type: 'string' },
    session: { type: 'string' },
    username: { type: 'string' },
    'icon-emoji': { type: 'string' },
    'user-email': { type: 'boolean', default: false },
    'no-context': { type: 'boolean', default: false },
    'unsafe-claim': { type: 'boolean', default: false },
    'as-app': { type: 'boolean', default: false },
    'as-coordinator': { type: 'boolean', default: false },
    whoami: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

/**
 * ⛔ AN UNKNOWN FLAG THREW A NODE STACK TRACE INSTEAD OF PRINTING USAGE.
 *
 *     TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--doctor'
 *     at node:internal/util/parse_args/parse_args:102
 *
 * ★ The reader who sees this is, by construction, someone who has just guessed wrong about
 * which script owns a flag - so it is the exact moment a usage string is most useful, and a
 * stack trace pointing into node internals is the least useful thing that could appear. It
 * reads as "the tool is broken" rather than "that flag lives elsewhere".
 *
 * ⚠ All three scripts did this, and the version reported only named one. Fixing the
 * reported one would have left the other two - the repo's own lesson about siblings.
 *
 * ★★★ AND ON WHY THE OLD REMEDY SURVIVED SO LONG — a peer's formulation, and it is the
 * argument for SCOPING rather than DELETING:
 *
 *     A TRUE CLAUSE CARRYING A FALSE CONCLUSION IS THE HARDEST KIND TO REMOVE,
 *     BECAUSE DELETING IT LOOKS LIKE DELETING SOMETHING TRUE.
 *
 * "A fresh export cannot reach a running process" is TRUE, and a restart reads as its
 * natural consequence - so every reviewer who checked the clause found it correct and
 * left the conclusion attached to it. The restart branch is right for a terminal-launched
 * editor and for Linux; it is wrong for a GUI-launched Mac. So it is CONDITIONED, not
 * cut - which is the same move this project makes with a withdrawn reading: banner the
 * correction, keep the text, and let the next reader see what was believed and why it
 * failed.
 *
 * ⛔⛔ AND THE CATCH MUST NOT REFERENCE `USAGE`: it is a const declared LATER in the file,
 * so reading it here throws a ReferenceError from inside the error handler - the message
 * prints and the process then dies on the recovery path. Found by running it, not by
 * reading it. `OPTIONS` is in scope because parseArgs itself needs it, so the flag list
 * comes from there and cannot go out of date.
 */
let a;
try {
  ({ values: a } = parseArgs({ options: OPTIONS, allowPositionals: false }));
} catch (e) {
  console.error(`${e.message}\n`);
  console.error(`known flags: ${Object.keys(OPTIONS).map((f) => `--${f}`).join(' ')}`);
  console.error('\nRun with --help for the full usage. ⚠ If you were looking for --doctor,');
  console.error('--presence, --ping, --raw, --audit, --show or --heartbeat, those belong to');
  console.error('slack-session-bus/slack-watch.mjs, not to this script.');
  process.exit(2);
}

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

/**
 * ⛔⛔⛔ SLACK MRKDWN IS NOT MARKDOWN - AND EVERY CLIENT THIS SCRIPT HAS DEFAULTS TO MARKDOWN.
 *
 * So the wrong dialect is not an occasional slip. It is the DEFAULT OUTPUT of the only kind
 * of author this tool has, which makes it a property of the tool rather than of the writer.
 *
 * ⚠ AND IT FAILS IN THE ONE DIRECTION NOTHING LOCAL CAN SEE. Slack STORES what you send and
 * renders in the CLIENT: the API returns ok: true, --raw shows exactly what you wrote, the
 * text reads perfectly in every tool here, and the damage is visible ONLY on a human's
 * screen. Hundreds of messages shipped before a human said "those are just printed
 * asterisks". No error, no warning, and no surface to check.
 *
 * Verified against docs.slack.dev/messaging/formatting-message-text rather than memory:
 *
 *     **bold**     -> *bold*        Slack bold is ONE asterisk
 *     __bold__     -> *bold*
 *     ~~strike~~   -> ~strike~      Slack strike is ONE tilde
 *     # Heading    -> *Heading*     SLACK HAS NO HEADINGS AT ALL
 *     [text](url)  -> <url|text>    Slack links are angle-bracketed
 *
 * ★ CONVERT, DO NOT WARN. A warning on every message is noise that gets ignored, and every
 * mapping above is unambiguous - a dialect translation, not a judgement call. But REPORT
 * what changed, so a surprising render is traceable to this function rather than mysterious.
 *
 * ⛔ CODE SPANS ARE SACRED. `**kwargs`, a regex full of asterisks, a diff OF markdown - all
 * legitimate content. Fenced blocks and inline code pass through untouched, which is why
 * this splits on them instead of running a global replace.
 *
 * ⚠ TABLES CANNOT BE FIXED HERE. Slack has no table syntax, so a markdown table renders as
 * rows of pipes. There is no lossless target to convert to - the honest move is to say so
 * and let the author restructure, not to silently mangle their columns.
 *
 * ★★ THE DIALECT WAS DECLARED IN THE PAYLOAD ALL ALONG, AND BOTH SESSIONS READ PAST IT:
 *
 *     { type: 'section', text: { type: 'mrkdwn', text: c } }
 *
 * `type: 'mrkdwn'` is not a formatting hint or a field label. IT IS THE NAME OF THE
 * LANGUAGE, on every message ever sent from here - and it was quoted back, verbatim, while
 * debugging a DIFFERENT bug in this same function, without either reader hearing it.
 *
 * ★★★ AND THIS FIX'S ACCEPTANCE CRITERION CANNOT BE AUTOMATED. --self-test proves the
 * converter TRANSFORMS STRINGS; only a screenshot proves the result RENDERS. Two text-only
 * readers of a text-only surface cannot see a render, and a third would not have helped:
 * the pair has different EVIDENCE, not different SENSES. A human here is not a tiebreaker,
 * they are the only instrument.
 *
 * ⚠ SO THE TEST FOR THIS FUNCTION IS A SCREENSHOT, AND THAT IS NOT A WEAKNESS OF THE TEST.
 * If you change the mapping, do not conclude from a green --self-test that it works. Send
 * one message and have a person look at it.
 */
function toSlackMrkdwn(text) {
  const changes = { bold: 0, strike: 0, headings: 0, links: 0, tableRows: 0 };
  if (!text) return { text, changes };
  // Fenced blocks first, so a stray backtick inside one cannot open an inline span. The
  // capture group keeps delimiters in the array, so odd indices are exactly the code spans.
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const out = parts.map((seg, i) => {
    if (i % 2 === 1) return seg;
    let s = seg;
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_m, inner) => { changes.bold += 1; return `*${inner}*`; });
    s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, (_m, inner) => { changes.bold += 1; return `*${inner}*`; });
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_m, inner) => { changes.strike += 1; return `~${inner}~`; });
    // Headings carry EMPHASIS rather than losing the line's rank silently. Closed ATX form
    // (trailing #s) handled too.
    s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_m, inner) => {
      changes.headings += 1;
      return `*${inner.trim()}*`;
    });
    // Not an image (leading !). An empty label degrades to a bare <url>, which Slack renders.
    s = s.replace(/(^|[^!])\[([^\]]*)\]\((\S+?)\)/g, (_m, pre, label, url) => {
      changes.links += 1;
      return `${pre}<${url}${label ? `|${label}` : ''}>`;
    });
    for (const line of s.split('\n')) {
      if (/^\s*\|.*\|\s*$/.test(line)) changes.tableRows += 1;
    }
    return s;
  });
  return { text: out.join(''), changes };
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const USAGE =
  'usage: node slack-post.mjs --channel <id> --text "..." [--thread-ts <ts>]\n' +
      '       [--text-file <path>] [--to X] [--type X] [--project X] [--session X]\n' +
      '       [--worktree X] [--raw-markdown]\n' +
      '       [--user X] [--machine X] [--closes <ts>] [--re <ts>] [--broadcast] [--no-broadcast]\n' +
      '       [--user-email] [--username X] [--icon-emoji :x:] [--unsafe-claim]\n' +
      '       [--no-context] [--as-app] [--as-coordinator] [--whoami] [--dry-run] [--self-test]\n' +
      '\n' +
      '  --as-coordinator  post using the COORDINATOR token (coordinator_token_env in\n' +
      '                  slack-workspace.json, default SLACK_COORDINATOR_BOT_TOKEN) instead\n' +
      '                  of the ordinary one. A separate credential for a separate role -\n' +
      '                  see slack-session-bus/SKILL.md for what a reader can and cannot\n' +
      '                  conclude from a message posted this way. (#165)\n' +
      '  --whoami        resolve the token (respecting --as-coordinator) and print its\n' +
      '                  team/bot_id/user_id from auth.test, then exit. Prints identifiers\n' +
      "                  only, never the token - run this once to learn a coordinator token's\n" +
      '                  bot_id and paste it into coordinator_bot_id.\n' +
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
      '  --cut-at <iso>  WHEN the release was cut, which is not when it was announced.\n' +
      '                  Without it, a late announcement is indistinguishable from a\n' +
      '                  prompt one and the lateness is unrecoverable. Adds resolution,\n' +
      '                  not trust.   git log -1 --format=%cI <tag>\n' +
      '  --released <v>  the version a --type release announces, as a context element.\n' +
      '                  A CLAIM ON A BUS, NOT A READING OF A DISK - --doctor reports it\n' +
      '                  and never acts on it. Required with --type release, and refused\n' +
      '                  on any other type, because a version element nobody reads is a\n' +
      '                  field that posts successfully and is counted by no one.\n' +
      '  --closes <ts>   which CLAIM a done/fail discharges - NOT the task. Mirrors\n' +
      '                  supersedes: on a takeover; without it a thread records what was\n' +
      '                  overridden but not what was fulfilled. Passing the thread parent\n' +
      '                  is REJECTED (exit 2): it records "this done closes this task",\n' +
      '                  which was never in doubt, while rendering like a real value.\n' +
      '  --re <ts>       which message THIS ONE ANSWERS, as a context element - e.g. an\n' +
      '                  x-pong echoing the x-ping it replies to. type: and session: alone\n' +
      "                  are not proof: they match a reply to something ELSE addressed to\n" +
      '                  the same target just as well. QUOTE IT, same reason as --thread-ts:\n' +
      '                  an unquoted ts can round to a float and simply fail to match, which\n' +
      '                  is silent here rather than loud (a reader degrades to UNCORRELATED,\n' +
      '                  it does not error).\n' +
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
 *
 * ⛔⛔⛔ AND A CASE IN THIS SUITE ONCE ASSERTED A DEFECT AND WENT GREEN. It read
 * `non-win32 says to restart the session` and passed, because the message said exactly
 * that - the advice SKILL.md deleted in the same release. A peer's formulation, and the
 * tell is mechanical rather than a matter of care:
 *
 *     A TEST WHOSE EXPECTED VALUE WAS COPIED FROM THE OUTPUT IS NOT A TEST.
 *     IT IS A SNAPSHOT WITH AN ASSERTION ATTACHED.
 *
 * The expectation and the implementation had the same author and the same source, so the
 * suite could only ever confirm that the code still did what the code did. A REAL
 * EXPECTATION HAS TO COME FROM SOMEWHERE THE IMPLEMENTATION CANNOT REACH - a spec, a
 * platform fact, a user need.
 *
 * ⛔ AND THE PLATFORM FACT WAS IN THIS SAME REPOSITORY, IN THE SECTION THE TEST WAS
 * CONTRADICTING. §A says in capitals that a restart on macOS is not a fix. The test
 * asserted the opposite and went green. That is the unread-evidence pattern with a GREEN
 * SUITE ON TOP OF IT - and a green suite is the one condition under which nobody goes
 * looking at the file next door.
 */
/**
 * ⛔⛔ A MANIFEST THAT HAS NEVER BEEN PASTED HAS NEVER BEEN VALIDATED.
 *
 * Both shipped manifests were REJECTED by Slack - `OAuth requires bot_user` - so PATH BUS
 * step 1 and PATH B step B1 both failed at their first action. The bus-only path was the
 * fix for a reported gap, and it could not be completed.
 *
 * Slack requires `features.bot_user` whenever `oauth_config.scopes.bot` is non-empty. The
 * bot scopes and the files arrived in the SAME commit: before it, the manifest lived
 * inline and declared USER scopes only, so no bot_user was required and the shape was
 * valid. Adding bot scopes created a dependency nothing checked.
 *
 * ★ AND THE FILE ALREADY KNEW. §B4a says of adding the scope by hand: "Bot Token Scopes
 * -> add chat:write. (CREATES THE BOT USER.)" The manifest route skips that click, so the
 * manifest must declare the bot user itself - and the one sentence recording the
 * dependency sat in the path that no longer needs it.
 *
 * Same class as the guards whose OUTPUT was never read: an artefact reviewed and shipped
 * without being EXECUTED once. Manifests are files now, so this is checkable.
 */
function checkManifests() {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = [];
  let files = [];
  try {
    files = readdirSync(here).filter((f) => f.startsWith('slack-app-manifest') && f.endsWith('.json'));
  } catch {
    return [['FAIL', 'could not read the skill directory to find manifests']];
  }
  if (!files.length) return [['FAIL', 'no slack-app-manifest*.json found beside this script']];
  for (const f of files) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(here, f), 'utf8'));
    } catch (e) {
      out.push(['FAIL', `${f} is not valid JSON: ${e.message}`]);
      continue;
    }
    const bot = m.oauth_config?.scopes?.bot ?? [];
    const botUser = m.features?.bot_user;
    if (bot.length && !botUser) {
      out.push(['FAIL', `${f} declares ${bot.length} bot scope(s) but no features.bot_user - Slack REJECTS this`]);
    } else if (bot.length) {
      out.push(['pass', `${f}: ${bot.length} bot scope(s) with features.bot_user "${botUser.display_name}"`]);
    } else {
      out.push(['pass', `${f}: no bot scopes, so no bot_user required`]);
    }
  }
  return out;
}

function selfTest() {
  // ⛔⛔ COUNT EVERY ASSERTION ACTUALLY EMITTED. Summing the case arrays was the obvious
  // implementation and it UNDERCOUNTED BY HALF, because several checks print pass/FAIL
  // outside any array - and a floor built on a number that does not see them is the very
  // defect this guards against. Wrapping the emitter cannot drift from the print sites.
  let ran = 0;
  const emit = console.log;
  console.log = (...z) => {
    if (/^ {2}(pass|FAIL)/.test(String(z[0] ?? ''))) ran += 1;
    emit(...z);
  };
  const CASE_FLOOR = 57; // raise when adding cases - a constant, reviewed on change (+1 for --re, #201; +7 resolutionTrace, #222)
  const flags = Object.keys(OPTIONS).filter((f) => f !== 'help');
  const missing = flags.filter((f) => !USAGE.includes(`--${f}`));
  for (const f of flags) console.log(`  ${USAGE.includes(`--${f}`) ? 'pass' : 'FAIL'}  --${f}`);
  const man = checkManifests();
  for (const [verdict, msg] of man) console.log(`  ${verdict}  ${msg}`);
  const manFailed = man.filter(([v]) => v === 'FAIL').length;

  /**
   * The dialect translation. Every case here was a real render defect on a human's screen,
   * and the CODE-SPAN cases are the ones that would rot silently: a converter that eats
   * `**kwargs` inside backticks corrupts content while every local surface still looks fine
   * - which is the exact failure this function exists to end.
   */
  const md = [
    ['bold  **x** -> *x*', toSlackMrkdwn('a **b** c').text, 'a *b* c'],
    ['bold  __x__ -> *x*', toSlackMrkdwn('a __b__ c').text, 'a *b* c'],
    ['strike ~~x~~ -> ~x~', toSlackMrkdwn('a ~~b~~ c').text, 'a ~b~ c'],
    ['heading -> bold line', toSlackMrkdwn('## Title').text, '*Title*'],
    ['closed ATX heading', toSlackMrkdwn('## Title ##').text, '*Title*'],
    ['link -> <url|label>', toSlackMrkdwn('see [docs](http://x.y)').text, 'see <http://x.y|docs>'],
    ['image left alone', toSlackMrkdwn('![alt](http://x.y)').text, '![alt](http://x.y)'],
    ['INLINE CODE UNTOUCHED', toSlackMrkdwn('use `**kwargs` here').text, 'use `**kwargs` here'],
    ['FENCED BLOCK UNTOUCHED', toSlackMrkdwn('```\n**x** # y\n```').text, '```\n**x** # y\n```'],
    ['a lone * is not bold', toSlackMrkdwn('2 * 3 * 4').text, '2 * 3 * 4'],
    ['# without space is not a heading', toSlackMrkdwn('#nothashtag').text, '#nothashtag'],
  ];
  for (const [name, got, want] of md) console.log(`  ${got === want ? 'pass' : 'FAIL'}  mrkdwn: ${name}`);

  /**
   * ★ BOTH PLATFORM ARMS, FROM WHICHEVER MACHINE IS RUNNING THIS. The bug was that the arm
   * the author could not execute named the DEFAULT variable instead of the resolved one, and
   * no amount of running the tool on Windows could ever have shown it.
   */
  const plat = [
    ['win32 names the resolved var', missingTokenMessage('SLACK_BOT_TOKEN_ACME', 'win32').includes('setx SLACK_BOT_TOKEN_ACME'), true],
    ['win32 does NOT name the default', missingTokenMessage('SLACK_BOT_TOKEN_ACME', 'win32').includes('SLACK_BOT_TOKEN "'), false],
    ['darwin names the resolved var', missingTokenMessage('SLACK_BOT_TOKEN_ACME', 'darwin').includes('export SLACK_BOT_TOKEN_ACME='), true],
    ['darwin does NOT name the default', /export SLACK_BOT_TOKEN=/.test(missingTokenMessage('SLACK_BOT_TOKEN_ACME', 'darwin')), false],
    ['linux names the resolved var', missingTokenMessage('SLACK_BOT_TOKEN_ACME', 'linux').includes('export SLACK_BOT_TOKEN_ACME='), true],
    // ⛔⛔ THIS CASE USED TO ASSERT THE DEFECT. It read `non-win32 says to restart the
    // session` and PASSED, because the message said exactly that - the advice §A had
    // deleted in the same release. A test can pin a bug in place as firmly as it pins a
    // fix, and a green suite is what stops anyone looking.
    ['non-win32 leads with the MEASURED remedy', /bash -lc/.test(missingTokenMessage('X', 'darwin')), true],
    ['non-win32 conditions any restart on a terminal launch', /ONLY if your editor was launched FROM A TERMINAL/.test(missingTokenMessage('X', 'darwin')), true],
    ['non-win32 says a GUI launch cannot be fixed by restarting', /no restart\n  reaches it/.test(missingTokenMessage('X', 'darwin')), true],
  ];
  for (const [name, got, want] of plat) console.log(`  ${got === want ? 'pass' : 'FAIL'}  token msg: ${name}`);
  const platFailed = plat.filter(([, got, want]) => got !== want).length;

  /**
   * resolutionTrace() (#222). Injected root/exists so the three states (no git root, a
   * root with no workspace file, a bound workspace) are checkable without a real git call
   * or filesystem read - and never touch a real credential, only a fixture var NAME.
   */
  const rt = [
    ['no git root names the cwd, not just the var', resolutionTrace('SLACK_BOT_TOKEN', null, () => false).includes(process.cwd()), true],
    ['no git root falls back to the given var', resolutionTrace('SLACK_BOT_TOKEN_ACME', null, () => false).includes('falling back to SLACK_BOT_TOKEN_ACME'), true],
    ['a root with no workspace file names the path it looked for', resolutionTrace('SLACK_BOT_TOKEN', 'C:\\repo', () => false).includes('C:\\repo\\.claude\\slack-workspace.json'), true],
    ['a root with no workspace file also falls back, not silently', resolutionTrace('SLACK_BOT_TOKEN', 'C:\\repo', () => false).includes('falling back to'), true],
    ['a bound workspace says BOUND, not fallback', resolutionTrace('SLACK_BOT_TOKEN_ACME', 'C:\\repo', () => true).includes('bound to'), true],
    ['a bound workspace does NOT say falling back', resolutionTrace('SLACK_BOT_TOKEN_ACME', 'C:\\repo', () => true).includes('falling back'), false],
    ['a bound workspace still names which var it declared', resolutionTrace('SLACK_BOT_TOKEN_ACME', 'C:\\repo', () => true).includes('SLACK_BOT_TOKEN_ACME'), true],
  ];
  for (const [name, got, want] of rt) console.log(`  ${got === want ? 'pass' : 'FAIL'}  resolutionTrace: ${name}`);
  const rtFailed = rt.filter(([, got, want]) => got !== want).length;

  const mdFailed = md.filter(([, got, want]) => got !== want).length;
  const tbl = toSlackMrkdwn('| a | b |\n| - | - |').changes.tableRows;
  console.log(`  ${tbl === 2 ? 'pass' : 'FAIL'}  mrkdwn: table rows counted (${tbl}), warned not converted`);

  // ⛔⛔ THE SUMMARY WAS THE BARE STRING `all pass`, WITH NO COUNT. A broken extraction
  // regex, a renamed section or an early return leaves every counter at zero and prints
  // exactly that - so A WHOLE BLOCK CEASING TO RUN IS INDISTINGUISHABLE FROM A GREEN SUITE.
  // Evidence it already bites: three reviewers reading these files reported three different
  // case totals for one deterministic command, because none of them could take the number
  // from the tool. Nobody can check a number the tool does not print. (#104)
  //
  // ⚠ THE FLOOR IS A CONSTANT, reviewed when it changes - NOT derived from the same arrays
  // it guards, which would move with them and assert nothing. Raise it when adding cases.
  const tooFew = ran < CASE_FLOOR;
  if (tooFew) console.log(`\n⛔ ONLY ${ran} CASES RAN, floor is ${CASE_FLOOR} - a block stopped running.`);
  const bad = missing.length + manFailed + mdFailed + platFailed + rtFailed + (tbl === 2 ? 0 : 1) + (tooFew ? 1 : 0);
  console.log(
    bad
      ? `\n${bad} FAILURE(S)${missing.length ? ` - flags missing from usage: ${missing.join(', ')}` : ''}`
      : `\n${ran} cases, all pass`,
  );
  process.exit(bad ? 1 : 0);
}

if (a['self-test']) selfTest();

/**
 * ⚠ SHORT-CIRCUITS BEFORE THE --channel/--text GATE, LIKE --self-test ABOVE IT. This is an
 * identity check, not a post - it needs neither a channel nor a body, and gating it behind
 * either would make "learn my coordinator token's bot_id" require inputs the operation
 * never uses. (#165)
 *
 * ⛔ PRINTS ONLY IDENTIFIERS. bot_id/user_id/team_id are safe to paste into a committed
 * slack-workspace.json exactly like team_id already is - NEVER the token itself.
 */
if (a.whoami) {
  const varName = a['as-coordinator'] ? coordinatorTokenVar() : tokenVar();
  const wToken = a['as-coordinator'] ? botToken(coordinatorTokenVar()) : botToken();
  if (!wToken) die(`${resolutionTrace(varName)}\n\n${missingTokenMessage(varName, process.platform)}`);
  const who = await whoAmI(wToken);
  if (!who.ok) die(`auth.test failed: ${who.error}`, 1);
  console.log(`team    : ${who.team} (${who.team_id})`);
  console.log(`bot_id  : ${who.bot_id ?? '(none - is this really a bot token?)'}`);
  console.log(`user_id : ${who.user_id ?? '(none)'}`);
  process.exit(0);
}

if (a.help || !a.channel || (a.text === undefined && a['text-file'] === undefined)) {
  console.error(USAGE);
  process.exit(a.help ? 0 : 1);
}

// Resolved once, here, so every downstream use is the real body.
const RAW_TEXT = resolveText();
const { text: TEXT, changes: MRKDWN_FIXES } = a['raw-markdown']
  ? { text: RAW_TEXT, changes: null }
  : toSlackMrkdwn(RAW_TEXT);
if (MRKDWN_FIXES) {
  const fixed = Object.entries(MRKDWN_FIXES)
    .filter(([k, v]) => v && k !== 'tableRows')
    .map(([k, v]) => `${v} ${k}`);
  if (fixed.length) console.error(`[post] converted Markdown to Slack mrkdwn: ${fixed.join(', ')} (--raw-markdown to disable)`);
  // Not convertible, so this one is a WARNING rather than a fix. Slack has no table syntax
  // and the rows will render as literal pipes.
  if (MRKDWN_FIXES.tableRows) {
    console.error(
      `[post] ⚠ ${MRKDWN_FIXES.tableRows} line(s) look like a Markdown table. SLACK HAS NO TABLES -\n` +
        '       these will render as rows of pipe characters. Restructure as a list, or put\n' +
        '       the table inside a code fence so it at least lines up.',
    );
  }
}

// ⚠ --as-coordinator SWAPS THE CREDENTIAL, NOT THE MESSAGE SHAPE. Everything below this line
// (type, context elements, mrkdwn) is unchanged - only WHICH token authenticates the post
// changes, so Slack stamps the resulting message with the coordinator's bot_id instead of
// the ordinary bot's. See slack-session-bus/SKILL.md for what a reader can conclude from
// that. (#165)
const token = a['as-coordinator'] ? botToken(coordinatorTokenVar()) : botToken();
if (!token) {
  /**
   * ⛔⛔ THIS NAMED THE RESOLVED VARIABLE AND THEN TOLD macOS USERS TO EXPORT THE DEFAULT.
   *
   * The win32 arm interpolated tokenVar(); the other arm was a plain string with
   * SLACK_BOT_TOKEN baked in. So on macOS a repo declaring its own `token_env` got a
   * correct, specific diagnosis followed by a remedy for a DIFFERENT VARIABLE - the reader
   * exports it, the tool still cannot see a token, and the same error repeats verbatim.
   *
   * ⚠ THE DIAGNOSIS BEING RIGHT IS WHAT MADE THE REMEDY CREDIBLE. Same class as #36: a
   * guard whose CONDITION is correct and whose OUTPUT is wrong - review reads conditions,
   * only firing reads output.
   *
   * ★ AND IT DATES ITSELF: the branch that had been RUN substituted correctly and the branch
   * that had not, did not. A PLATFORM-CONDITIONAL BRANCH IS ONLY EVER AS GOOD AS THE PLATFORM
   * IT WAS RUN ON - which generalises past platforms to any branch gated on an environment
   * the author does not have. It is untested by construction, not by oversight.
   *
   * ⚠ It also lands hardest on the newer path: `token_env` exists so one machine can hold
   * several workspaces' tokens, so ANYONE SEEING THIS MESSAGE IS BY CONSTRUCTION SOMEONE FOR
   * WHOM THE DEFAULT IS WRONG.
   */
  const missingVar = a['as-coordinator'] ? coordinatorTokenVar() : tokenVar();
  die(`${resolutionTrace(missingVar)}\n\n${missingTokenMessage(missingVar, process.platform)}`);
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
    // ⚠ THE SEPARATOR IS KEPT, NOT STRIPPED, SO THE SPLIT IS EXACTLY REVERSIBLE.
    //
    // It used to be trimmed for tidier rendering, which made concatenating the blocks
    // back together lossy: words ran into each other and paragraph breaks vanished at
    // every boundary. That did not matter while the reader only ever showed the FIRST
    // block - a defect that silently truncated 24 messages before it was found - and it
    // matters now that the reader rejoins them. A writer that splits must split in a way
    // its reader can undo; anything else moves the loss rather than removing it.
    rest = rest.slice(cut);
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
const KNOWN_TYPES = ['request', 'reply', 'claim', 'done', 'fail', 'status', 'release'];

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
/**
 * ⛔⛔ `--closes` NAMES THE **CLAIM** A done/fail DISCHARGES, NOT THE TASK.
 *
 * Passing the thread parent makes the field SELF-REFERENTIAL: `closes: <this thread>`
 * asserts "this done closes this task", which was never in doubt. The field carries
 * exactly zero information, and renders identically to a correct one.
 *
 * ★ AND THE WRONG VALUE IS THE CONVENIENT ONE, WHICH IS WHY THIS NEEDS A GUARD RATHER
 * THAN A DOC LINE. The task ts is already in your hand - it is the --thread-ts you just
 * typed. The claim ts is buried in slack-claim's output and has to be captured
 * deliberately. So the ergonomics push toward the useless value, and nothing in the
 * output distinguishes them.
 *
 * ★ Measured: in an 8-agent scale run, FIVE OF SIX dones carried the task ts. Nothing
 * objected - not this script, not the audit written to check it, not the peer who
 * pre-registered "closes: names a real claim" as a pass criterion and then did not run
 * it. Three independent chances to catch it and it survived all three.
 *
 * ⚠ In an ordinary thread nobody notices, because the winner is recoverable from the
 * claims anyway. IN A TAKEOVER THREAD - the case this field exists for - it would be
 * silently useless at precisely the moment it is the only evidence.
 *
 * This cannot fire on a correct value: a claim ts is never the thread parent.
 */
if (a.closes && a['thread-ts'] && a.closes === a['thread-ts']) {
  die(
    '--closes must name the CLAIM this done/fail discharges, not the task.\n' +
      '\n' +
      `  You passed the thread parent (${a.closes}) for both --closes and --thread-ts.\n` +
      '  That records "this done closes this task", which was never in question, and\n' +
      '  the field then carries no information at all - while rendering exactly like a\n' +
      '  correct one. In a takeover thread that is the only evidence of what was\n' +
      '  fulfilled, and it would be silently empty.\n' +
      '\n' +
      '  The value you want is the ts of the CLAIM being discharged - slack-claim.mjs\n' +
      '  prints it when it posts one.',
    2,
  );
}

/**
 * ⚠ THE TWO HALVES OF A RELEASE ANNOUNCEMENT TRAVEL TOGETHER OR NOT AT ALL.
 *
 * A `type: release` with no version announces nothing a reader can use, and a `released:`
 * on any other type puts a version where no reader looks for one. Both fail the same way
 * this project keeps finding: posted successfully, counted by nobody.
 */
if (a.type === 'release' && !a.released) {
  die(
    '--type release needs --released <version>.\n' +
      '  A release announcement with no version announces nothing a reader can act on,\n' +
      '  and --doctor reads the version off the context element, never the body.',
    2,
  );
}
if (a['cut-at'] && a.type !== 'release') {
  die(
    `--cut-at was given with --type ${a.type ?? '(none)'}.
` +
      '  It records when a RELEASE was cut, and is only read on a release announcement.',
    2,
  );
}
if (a['cut-at'] && Number.isNaN(Date.parse(a['cut-at']))) {
  die(
    `--cut-at "${a['cut-at']}" is not a parsable date.
` +
      '  Use ISO 8601. The tag knows it:  git log -1 --format=%cI <tag>',
    2,
  );
}
if (a.released && a.type !== 'release') {
  die(
    `--released was given with --type ${a.type ?? '(none)'}.\n` +
      '  The version element is only read on a release announcement; anywhere else it is\n' +
      '  a field no reader looks at.',
    2,
  );
}

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

/**
 * ⚠ A WARNING, NOT A die(). The two flags are DELIBERATELY not coupled - the security
 * boundary lives entirely in verifyBotId() on the READ side (slack-watch.mjs), and no
 * amount of coupling here would strengthen it: an adversary forging a directive would
 * simply omit --as-coordinator, so refusing this combination would only ever block an
 * HONEST sender who forgot a flag, not a dishonest one. What IS worth catching is exactly
 * that honest mistake - a post that succeeds, returns ok:true, and silently never
 * verifies, which is this repo's own most common failure shape: a wrong value rendering
 * exactly like a right one. (#165)
 */
if (a.type === 'x-directive' && !a['as-coordinator']) {
  console.error(
    "[post] ⚠ --type x-directive without --as-coordinator: this token's bot_id will not\n" +
      '       match the declared coordinator, so a verifying reader sees this as NOT VERIFIED.\n' +
      '       Pass --as-coordinator if this is meant to read as authoritative.',
  );
}

/**
 * ⚠ THE SIBLING GAP TO THE CHECK ABOVE, NOT THE SAME ONE. That check catches --type
 * x-directive without --as-coordinator; this catches --as-coordinator whose OWN repo binding
 * has not declared what a reader would check the message against. `.claude/slack-workspace.json`
 * is COMMITTED, so every reader who has pulled this repo's copy is in exactly the same
 * boat as the poster - an absent coordinator_bot_id here does not just affect THIS post, it
 * means nothing posted as coordinator from this repo can currently verify for anyone. A
 * WARNING, not a die(), for the same reason repoWorkspace()'s own doc comment gives: an
 * absent coordinator_bot_id already fails in the safe direction (unverified, never a false
 * positive), so refusing to post would only block an already-safe mistake. (#175)
 */
if (a['as-coordinator'] && !repoWorkspace()?.coordinator_bot_id) {
  console.error(
    "[post] ⚠ --as-coordinator, but this repo's slack-workspace.json declares no\n" +
      '       coordinator_bot_id: no reader of this binding can verify anything posted as\n' +
      '       coordinator, including this message. Run --whoami --as-coordinator and paste\n' +
      '       the printed bot_id into coordinator_bot_id to fix it.',
  );
}

const payload = { channel: a.channel, text: TEXT };

// Same validation as --thread-ts, same reason - but where an unquoted --thread-ts fails
// LOUDLY (Slack posts to the wrong place and still returns ok:true), an unquoted --re fails
// QUIETLY: the mangled value simply never string-equals a real ts, so a reader degrades to
// UNCORRELATED rather than erroring. Validate anyway so the mistake is visible here rather
// than only inferred later from a pong that reads weaker than it should. (#201)
if (a.re && !/^\d{10,}\.\d{6}$/.test(a.re)) {
  die(
    `--re "${a.re}" is not a valid Slack timestamp (expected 1234567890.123456).\n` +
      'Quote it at the call site: an unquoted ts can be rounded to a float, and a reader\n' +
      'would then read this as UNCORRELATED rather than reporting an error.',
  );
}

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
  const worktree = a.worktree ?? worktreeLabel();
  const sessionFallback = sessionLabel();
  const session = a.session ?? sessionFallback.label;
  // Only true when --session was NOT passed AND the fallback used the truncated session id
  // rather than CLAUDE_SESSION_NAME - a human (or a session) choosing to name itself is not
  // a default, regardless of which mechanism they used to say so.
  const sessionDefaulted = !a.session && sessionFallback.defaulted;
  const machine = a.machine ?? process.env.CLAUDE_SLACK_MACHINE ?? envFromRegistry('CLAUDE_SLACK_MACHINE') ?? hostname();
  const wantEmail =
    a['user-email'] ||
    ['1', 'true', 'yes'].includes(
      (process.env.CLAUDE_SLACK_USER_EMAIL ?? envFromRegistry('CLAUDE_SLACK_USER_EMAIL') ?? '').toLowerCase(),
    );
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
  // Which message THIS one answers - an x-pong echoing the x-ping it replies to, so a
  // reader can tell "a pong-shaped message landed after my ping" from "a pong-shaped
  // message answered MY ping specifically". type:/session: alone cannot: they match a
  // reply to something else addressed to the same target just as well. (#201)
  if (a.re) elements.push({ type: 'mrkdwn', text: `re: \`${a.re}\`` });
  // ★ THE VERSION OF A RELEASE, AS A CONTEXT ELEMENT - a peer's design, and the whole
  // point is that it is a CLAIM ON A BUS, NOT A READING OF A DISK. It says "someone said
  // they cut this", never "this is installable here". --doctor reports it and never acts
  // on it, in the same vocabulary it uses for PEERS.
  //
  // Why it exists: `released` `cached` and `resident` drift, and all three directions
  // were hit in one day, each reporting success. The gap between CUTTING and INSTALLING
  // is currently visible only to whoever cut - and at one point the only place a released
  // version existed on this machine was inside a Slack message body, which is the one
  // surface --doctor could not read.
  if (a.released) elements.push({ type: 'mrkdwn', text: `released: \`${a.released}\`` });
  /**
   * ★ WHEN IT WAS CUT, WHICH IS NOT WHEN IT WAS ANNOUNCED.
   *
   * ⛔ WITHOUT THIS, A LATE ANNOUNCEMENT ERASES THE EVIDENCE THAT IT WAS LATE. Observed:
   * 2.14.0 shipped and went unannounced for 4790 seconds; the announcement then rendered
   * as `ANNOUNCED 2.14.0 (56s ago)` - INDISTINGUISHABLE from having announced promptly.
   * The window left no trace at all.
   *
   * That made `announced < cached` a LIVE-ONLY signal: true only inside the gap, and
   * destroyed by the very act that closes it. The third such signal found in one day,
   * after the version-gap doctor state and the hearsay branch - and a finding visible
   * only to someone who happened to look in the right minute is barely a finding.
   *
   * ⚠ IT ADDS NO TRUST. Same claimant, still a claim, still not a reading of a disk. It
   * adds RESOLUTION, which is the honest thing a claim can offer: with a cut time,
   * "announced 80 minutes after the release" becomes a fact in the record forever,
   * instead of an inference available for one window to one observer.
   *
   * Get it from the tag rather than typing it:  git log -1 --format=%cI v2.15.0
   */
  if (a['cut-at']) elements.push({ type: 'mrkdwn', text: `cut: \`${a['cut-at']}\`` });

  if (project) elements.push({ type: 'mrkdwn', text: `project: \`${project}\`` });
  // Only present when you are standing in a linked worktree. `project:` stays the REPO so
  // peers filtering on it see one project; the slot rides alongside rather than inside it.
  if (worktree) elements.push({ type: 'mrkdwn', text: `worktree: \`${worktree}\`` });
  if (session) elements.push({ type: 'mrkdwn', text: `session: \`${session}\`` });
  // ⛔⛔ A SEPARATE ELEMENT, NEVER APPENDED TO session:'s OWN VALUE. meta()'s parser captures
  // EVERYTHING after "key: " as that key's value - appending text there once corrupted the
  // identifier itself (measured live: a claim posted this way, on `slack-claim.mjs`, could not
  // recognise its own session as the one it had just posted, because "b4adab04" and
  // "b4adab04 (DEFAULTED - no --session given)" do not string-compare equal anywhere this
  // codebase matches on session). DEFAULTED, NOT LABELLED - marked the same way --doctor
  // already marks the identical fallback, so the ONE reader who could fix a mislabelled lane
  // (the sender) sees it too, without touching the field every match in this codebase reads. (#203)
  if (sessionDefaulted) elements.push({ type: 'mrkdwn', text: 'session-defaulted: `true` (no --session given - see session:)' });
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

// ⚠ CHECKED EVEN ON --dry-run. "Where is this going" must be answerable WITHOUT
// sending, and the destination is exactly what a preview was silently omitting.
const WS = await checkWorkspace(token, { enforce: !a['dry-run'] });

/**
 * ⛔⛔ A REAL SEND HAD NO EQUIVALENT OF --dry-run's `workspace:` LINE. WS.want was already
 * computed by the line above either way - a MISMATCH already dies with the full detail
 * below, but the two cases with NOTHING WRONG on this check's own terms said nothing at
 * all: no local binding at all (silently falls back to a bare var name - #222's first two
 * measured arms), and a binding that DOES match but happens to belong to the WRONG repo
 * (two repos sharing one team_id/token_env - #222's fourth arm, "the only tell is one
 * field in a context block"). Printed on every real send, not only a --dry-run preview,
 * because the preview is exactly the step a session under time pressure skips.
 */
if (!a['dry-run']) {
  console.error(
    WS.want
      ? `[post] bound to ${WS.want.path}`
      : `[post] ⚠ ${resolutionTrace(a['as-coordinator'] ? coordinatorTokenVar() : tokenVar())} - if this lands somewhere unexpected, that is why.`,
  );
}

/**
 * ⚠ THE MISMATCH HALF OF THE ABSENCE CHECK ABOVE (line ~1255), NOT A NEW CHECK.
 * repoWorkspace()'s own docblock has always said "absent OR wrong coordinator_bot_id" -
 * only the absent half was ever guarded. A wrong value fails in the UNSAFE direction:
 * verifyBotId() (slack-watch.mjs) resolves it to `forged`, the same rendering as an
 * actual impersonation attempt, on a message the real coordinator sent. (#184)
 *
 * No second auth.test call: checkWorkspace() above just made one for THIS token, which
 * IS the coordinator token here (--as-coordinator swapped it before line 1391), so
 * WS.who.bot_id is already the answer. Guarded on WS.who.ok - an unanswered auth.test
 * is not a mismatch, the same distinction checkWorkspace()'s own docblock draws.
 */
const declaredCoordinatorBotId = repoWorkspace()?.coordinator_bot_id;
if (a['as-coordinator'] && declaredCoordinatorBotId && WS.who.ok && WS.who.bot_id !== declaredCoordinatorBotId) {
  console.error(
    "[post] ⚠ --as-coordinator, but this token's bot_id does not match this repo's\n" +
      `       declared coordinator_bot_id (declared ${declaredCoordinatorBotId}, actual\n` +
      `       ${WS.who.bot_id}). A verifying reader sees this as !NOT-FROM-COORDINATOR - the\n` +
      '       same rendering as a forged directive. Run --whoami --as-coordinator and update\n' +
      '       coordinator_bot_id if the coordinator app was reinstalled or its token rotated.',
  );
}

if (a['dry-run']) {
  console.log('DRY RUN - nothing sent.');
  console.log(`  workspace: ${workspaceLine(WS)}`);
  // ⛔ WAS: `WS.want && !WS.verified`, with no test of WS.who.ok - so an UNANSWERED auth.test
  // rendered as a workspace MISMATCH. That is the exact conflation checkWorkspace's own
  // comment forbids four hundred lines above: "A failed auth.test is NOT a mismatch - it is
  // an unanswered question. Say which." slack-watch.mjs:1957 guards correctly with
  // `&& WS.who.ok`; this sibling did not, and §0's verdict table has no row for the
  // unverified case - so a stale token sent the reader to edit a committed declaration. (#103)
  if (WS.want && !WS.verified && WS.who?.ok) {
    console.log('  ⛔ MISMATCH - a real send would REFUSE. See above.');
  } else if (WS.want && !WS.verified) {
    console.log('  ⚠ UNVERIFIED, which is NOT a mismatch - auth.test did not answer, so the');
    console.log('  workspace question is OPEN. Do NOT edit the declaration on this: fix the');
    console.log('  credential or the network first, then re-run. A real send would refuse,');
    console.log('  because an unanswered check cannot authorise a post.');
  }
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
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  // Kept so a 429 can report what Slack asked for - the sibling scripts do this and this
  // one, the highest-volume write path on the bus, did not. (#119)
  if (r.status === 429) {
    const headerSecs = Number(r.headers.get('retry-after'));
    res = { ...(await r.json()) };
    res.retryAfter = Number.isFinite(headerSecs) && headerSecs > 0 ? headerSecs : null;
  } else {
    res = await r.json();
  }
} catch (err) {
  die(`Request to Slack failed: ${err.message}`);
}

if (!res.ok) {
  const hints = {
    not_in_channel: 'The bot is not a member of that channel. In Slack: /invite @<app display name>',
    channel_not_found: 'Unknown channel id. Resolve it with mcp__slack__slack_search_channels.',
    invalid_auth: `The bot token is stale - someone reinstalled the app. Re-copy it and re-set ${tokenVar()}.`,
    token_revoked: 'The bot token was revoked. Re-copy it from OAuth & Permissions.',
    missing_scope: 'The app lacks a required scope. --username/--icon-emoji need chat:write.customize.',
  };
  if (res.error === 'ratelimited') {
    console.error('Slack RATE LIMITED this post.');
    console.error(
      res.retryAfter
        ? `  Slack asks for ${res.retryAfter}s before the next request.`
        : '  Slack sent no Retry-After header.',
    );
    console.error('  ⛔ NOT RETRIED HERE, DELIBERATELY. A 429 is a property of the CHANNEL, so it');
    console.error('  hits every contender at once and a retry deepens it for all of them.');
  } else {
    console.error(`Slack rejected the post: ${res.error}`);
    if (hints[res.error]) console.error(hints[res.error]);
  }
  process.exit(1);
}

const as = payload.username ? `as '${payload.username}'` : 'as the app';
console.log(`Posted to ${res.channel} ${as}${payload.blocks ? ` [${contextLine}]` : ''} - ts ${res.ts}`);
