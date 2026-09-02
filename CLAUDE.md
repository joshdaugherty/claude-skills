# CLAUDE.md — `claude-skills`

**Read this first. It is loaded into every session opened to this repo.** Everything here is durable; the detail lives in the files it points at.

---

## What this repo is

A Claude Code **plugin marketplace** (`.claude-plugin/marketplace.json`) carrying one plugin, **`slack-as-claude`** — a Slack channel used as a bus so concurrent Claude sessions on different machines can talk to each other.

# ⚠ Its product is **instructions plus three `.mjs` scripts**, and the instructions *are* the behaviour.
### **A `SKILL.md` edit is a code change.** *A session does what the file says; a wrong sentence ships as a wrong action.* **The four highest-cost defects this project has produced were all instructions**, not code: a restart command that leaves the reader invisible, a remedy that cannot work on the platform it names, an update procedure that updates nothing, and a credential check that leaks the credential.

---

## ⛔⛔ BEFORE YOU SHIP — THE STANDING ORDER

# **Run an adversarial review of the diff: [`.claude/rules/adversarial-review.md`](.claude/rules/adversarial-review.md).**

### **A green `--self-test` earns the BUILD, not the SHIP.** *The author and the author's tests share the same blind spots.* **This repo has shipped, in one day, a test that asserted the defect it was written to prevent, a diagnostic that crashed only when it had something to report, and one instruction wrong in four separate string literals. Every one passed `--self-test`.**

★ **The rule also names the three defect tiers and which one no agent can reach** — *the mrkdwn defect shipped for two days with `ok: true`, `--raw` correct and `--doctor` clean, because its only possible observer was a human's screen.* # **For that tier: name the observer you lack and go get them.**

---

## The gate — run all of it, after the review's fixes, not before

```
node plugins/slack-as-claude/skills/slack-as-claude/slack-post.mjs      --self-test
node plugins/slack-as-claude/skills/slack-session-bus/slack-watch.mjs   --self-test
node plugins/slack-as-claude/skills/slack-session-bus/slack-claim.mjs   --self-test
node --check <every .mjs touched>
awk '$0 ~ /^>?[[:space:]]*\|/ { if ($0 !~ /\|[[:space:]]*$/) print "BAD ROW " NR }' <every SKILL.md touched>
```

- ⚠ **`--self-test` has given a false pass before**, by grepping the whole file instead of the usage string — *a check that could not tell **documented** from **merely mentioned**.*
- **`node --check` has caught a doubled `*/` twice.**

---

## ⛔ The three lines you do not cross

| ⛔ **Running a script WRITES to a shared channel** | *`slack-post.mjs`, `--announce-install` and `--retire` all post; **`--retire` deletes**. Other sessions are reading that bus and the artefacts are permanent.* # **`--dry-run` is the safe probe** — *it resolves declaration → `token_env` → registry → `auth.test` → binding and **sends nothing**.* |
| :-- | --- |
| ⛔ **Never print a credential** | ### **Two leaks in one day, both from an agent answering the innocent question *"is the token set?"*.** *A registry dump, an `echo $VAR`, a `reg query` on `HKCU\Environment` — all leak.* # **Compare and report a verdict. Never echo a value.** |
| ⛔ **A `+dev` tree is not evidence** | *The suffix voids the version as a claim about the code **and** voids any message sent from it — **nobody can later identify the build**. **Verify against the released copy**, or say plainly that the subject was an authoring tree.* |

---

## The loops

| **Issues** | **branch → commit → PR to `main` carrying `Closes #N` → merge.** # ⚠⚠ **READ THE ISSUE'S COMMENTS, NOT ONLY ITS BODY.** *#70 exists because a comment posted **four minutes** after the body corrected it and was never read; the body was implemented faithfully and the ticket was still wrong.* |
| :-- | --- |
| **Releases** | **Bump `version` in `plugins/slack-as-claude/.claude-plugin/plugin.json` or installs will not see the change.** *Then tag, announce **from the released copy**, install, move the registrations.* # ⚠ **Ask Joshua before cutting a release.** |
| **Registrations** | ### **`claude plugin marketplace update` refreshes the CATALOG. `claude plugin install` populates a CACHE DIRECTORY.** # **Only `claude plugin update` moves a REGISTRATION** *(measured: 39 installs, 0 registrations moved)*, **and it defaults to `--scope user`** — *a registration is pinned per scope in `~/.claude/plugins/installed_plugins.json`.* |

---

## The defect shapes this repo keeps producing

**Grep this list before calling a fix complete.**

1. # **A fix landing where it was reported and nowhere else.** *`--heartbeat` was missing from **four** string literals; three separate releases each fixed one.* **Sweep for siblings.**
2. # **A surface confidently reporting what the underlying state does not support.** *`--doctor` read the newest cache **directory** and printed `INSTALLED`.*
3. # **A guard that has never fired has never been read.** *Force every failure-only branch.*
4. # **A stored conclusion about the world, ageing silently.** *"Only one registration is reachable" shipped three times and was false within the hour.* ## ★ **Emit the observation, not the conclusion.**

★ *A claim about the **world** must be regenerated. A claim about your own **history** — "this tool previously asserted otherwise and was wrong" — is safe to store forever. **The past does not move.***
