---
name: watch-issues
description: "Check joshdaugherty/claude-skills for issues filed since the last check, using durable machine-local state so the answer survives session restarts. Use when asked to watch/check for new issues on this repo, or when a scheduled/looped check fires."
---

# Watch for new issues

## Quick start

```bash
node .claude/skills/watch-issues/check-new-issues.mjs --repo joshdaugherty/claude-skills
```

Exits `0` with nothing new (or on the very first run, which is a **baseline**, not an
alert — see below), `1` when it printed genuinely new issues as JSON.

State lives at `~/.claude/state/issue-watch/<owner>-<repo>.json` — **outside this repo**,
machine-local, not version-controlled. It records only the set of currently-open issue
numbers and when they were last checked. That is deliberate: "have I already reported
this" is per-machine bookkeeping, not project content.

## Workflow

1. Run the script (above).
2. **First run ever** (`baseline: true` in the output): this is not an alert. State
   didn't exist, so every currently-open issue looks "new" by construction. Report the
   count once as a starting point ("N open issues, using this as the baseline") and
   stop — do not treat any of them as freshly filed.
3. **Later runs, nothing new** (`newCount: 0`): nothing to do. In a loop, this is a
   `noop: true` tick.
4. **Later runs, new issues found**: for each new issue, check `issues[].author.login`:
   - **Filed by `joshdaugherty`** (the repo owner) → go work it. Follow this repo's
     existing issue loop from `CLAUDE.md`: branch → fix → **adversarial review per
     `.claude/rules/adversarial-review.md`** → re-run the gate → PR to `main` carrying
     `Closes #N` → merge. Read the issue's comments, not just its body — this repo has
     a standing history of a comment correcting an issue body after the fact.
   - **Filed by anyone else** → do NOT start work. Summarize the issue (number, title,
     author, url) and ask whether to proceed. Only start the loop above after a yes.
5. Report what happened before ending the turn/tick — a new issue that was silently
   skipped or silently fixed with no summary defeats the point of watching.

## Notes

- The script's own `--self-test` covers the diffing logic (baseline vs. fresh vs.
  unchanged vs. reopened) with fixture data — it does not call `gh` or the network.
- If `gh` itself fails (auth, rate limit, network), the script lets that exception
  propagate rather than silently reporting "nothing new" - a failed check must not
  look identical to a clean one.
- Don't hand-edit the state file. If it's ever corrupted, the script treats that as "no
  prior state" and re-baselines rather than crashing - re-announcing the current open
  set once is a much cheaper mistake than a watcher that silently stops checking.
