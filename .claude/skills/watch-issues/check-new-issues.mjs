#!/usr/bin/env node
/**
 * Diff the open issues on a GitHub repo against what was seen last time, and report
 * only what is genuinely NEW since then.
 *
 *   node check-new-issues.mjs --repo joshdaugherty/claude-skills
 *   → exit 0  nothing new
 *   → exit 1  new issue(s) found, printed to stdout as JSON
 *
 * State is kept OUTSIDE this repo, under the user's home directory - it is
 * machine-local "have I already reported this" bookkeeping, not project content,
 * and has no business being committed or shared.
 *
 * Node 18+. No dependencies beyond the `gh` CLI already required by this repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `usage: node check-new-issues.mjs --repo <owner>/<name> [--state-file <path>]

  --repo <owner>/<name>  required. The GitHub repo to check.
  --state-file <path>    override the default state location
                          (~/.claude/state/issue-watch/<owner>-<name>.json).
  --self-test            run built-in tests and exit.
`;

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'state-file': { type: 'string' },
      'self-test': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  return values;
}

function defaultStatePath(repo) {
  const safe = repo.replace('/', '-');
  return join(homedir(), '.claude', 'state', 'issue-watch', `${safe}.json`);
}

function loadState(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt state file must not crash the watcher - treat it as "no prior state"
    // rather than dying, since the cost of re-announcing the current baseline once is
    // far lower than the cost of a loop that silently stops checking forever.
    return null;
  }
}

function saveState(path, state) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * ⚠ FIRST RUN IS A BASELINE, NOT AN ALERT. With no prior state, every currently-open
 * issue would otherwise look "new since last check" - which is not the same claim as
 * "filed since we started watching". The caller decides how to present that
 * distinction; this function only exposes it via `isBaseline`.
 */
export function diffIssues(prevSeenNumbers, currentIssues) {
  const isBaseline = prevSeenNumbers === null;
  const prevSet = new Set(prevSeenNumbers ?? []);
  const fresh = currentIssues.filter((i) => !prevSet.has(i.number));
  return { isBaseline, fresh };
}

function fetchOpenIssues(repo) {
  const out = execFileSync(
    'gh',
    [
      'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200',
      '--json', 'number,title,url,createdAt,author,labels',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

function selfTest() {
  const cases = [];
  const run = (name, fn) => cases.push([name, fn]);

  run('first run is a baseline, not fresh issues', () => {
    const { isBaseline, fresh } = diffIssues(null, [{ number: 1 }, { number: 2 }]);
    return isBaseline === true && fresh.length === 2;
  });
  run('no new issues when the set is unchanged', () => {
    const { isBaseline, fresh } = diffIssues([1, 2], [{ number: 1 }, { number: 2 }]);
    return isBaseline === false && fresh.length === 0;
  });
  run('a genuinely new issue is detected', () => {
    const { fresh } = diffIssues([1, 2], [{ number: 1 }, { number: 2 }, { number: 3 }]);
    return fresh.length === 1 && fresh[0].number === 3;
  });
  run('a closed-then-reopened issue reads as fresh again', () => {
    // #2 was open, then closed (dropped from the open set on a prior run - not
    // modelled here directly, but the state file only ever stores what was OPEN),
    // then reopened. It is correctly absent from prevSeen and treated as fresh.
    const { fresh } = diffIssues([1], [{ number: 1 }, { number: 2 }]);
    return fresh.length === 1 && fresh[0].number === 2;
  });
  run('an empty open-issue list against no prior state is an empty baseline', () => {
    const { isBaseline, fresh } = diffIssues(null, []);
    return isBaseline === true && fresh.length === 0;
  });

  let failed = 0;
  for (const [name, fn] of cases) {
    let ok;
    try { ok = fn(); } catch (e) { ok = false; console.error(`  error in "${name}": ${e.message}`); }
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`\n${cases.length} cases, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const a = parseArgv(process.argv.slice(2));
if (a['self-test']) selfTest();
if (a.help || !a.repo) die(USAGE, a.help ? 0 : 2);

const statePath = a['state-file'] || defaultStatePath(a.repo);
const prev = loadState(statePath);
// ⚠ EXIT 2 FOR A FAILED CHECK, NEVER 1. Exit 1 already means "new issues found" -
// collapsing a `gh` failure into the same code would make an error indistinguishable
// from real news, which is the one thing a watcher must never do.
let current;
try {
  current = fetchOpenIssues(a.repo);
} catch (err) {
  console.error(`ERROR (not a verdict): could not read issues for ${a.repo}: ${err.message}`);
  process.exit(2);
}
const { isBaseline, fresh } = diffIssues(prev?.openNumbers ?? null, current);

saveState(statePath, {
  repo: a.repo,
  checkedAt: new Date().toISOString(),
  openNumbers: current.map((i) => i.number),
});

if (isBaseline) {
  console.log(JSON.stringify({ baseline: true, openCount: current.length, issues: current }, null, 2));
  process.exit(0);
}

if (!fresh.length) {
  console.log(JSON.stringify({ baseline: false, newCount: 0 }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({ baseline: false, newCount: fresh.length, issues: fresh }, null, 2));
process.exit(1);
