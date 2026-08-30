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
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const API = 'https://slack.com/api/chat.postMessage';

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

const { values: a } = parseArgs({
  options: {
    channel: { type: 'string' },
    text: { type: 'string' },
    'thread-ts': { type: 'string' },
    project: { type: 'string' },
    user: { type: 'string' },
    machine: { type: 'string' },
    session: { type: 'string' },
    username: { type: 'string' },
    'icon-emoji': { type: 'string' },
    'user-email': { type: 'boolean', default: false },
    'no-context': { type: 'boolean', default: false },
    'as-app': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (a.help || !a.channel || a.text === undefined) {
  console.error(
    'usage: node slack-post.mjs --channel <id> --text "..." [--thread-ts <ts>]\n' +
      '       [--project X] [--session X] [--user X] [--machine X] [--user-email]\n' +
      '       [--username X] [--icon-emoji :x:] [--no-context] [--as-app] [--dry-run]',
  );
  process.exit(a.help ? 0 : 1);
}

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

const payload = { channel: a.channel, text: a.text };

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
  if (project) elements.push({ type: 'mrkdwn', text: `project: \`${project}\`` });
  if (session) elements.push({ type: 'mrkdwn', text: `session: \`${session}\`` });
  if (user) elements.push({ type: 'mrkdwn', text: `user: ${user}` });
  if (machine) elements.push({ type: 'mrkdwn', text: `machine: ${machine}` });
  elements.push({ type: 'mrkdwn', text: `os: ${osLabel()}` });

  contextLine = elements.map((e) => e.text).join('  ');

  // 'text' stays the raw message so push notifications and unfurls read correctly.
  if (!a['no-context'] && elements.length) {
    payload.blocks = [
      { type: 'context', elements },
      { type: 'section', text: { type: 'mrkdwn', text: a.text } },
    ];
  }
}

// --- send -------------------------------------------------------------------

if (a['dry-run']) {
  console.log('DRY RUN - nothing sent.');
  console.log(`  channel  : ${a.channel}`);
  console.log(`  username : ${payload.username ?? "(the app's own name)"}`);
  console.log(`  icon     : ${payload.icon_emoji ?? "(the app's own avatar)"}`);
  console.log(`  context  : ${payload.blocks ? contextLine : '(none)'}`);
  if (payload.thread_ts) console.log(`  thread_ts: ${payload.thread_ts}`);
  console.log(`  text     : ${a.text}`);
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
