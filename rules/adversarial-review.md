# Rule — adversarially verify before shipping

When you have built a substantive change and the self-tests are green, **do not ship on the strength of your own tests alone.** First run an **adversarial review** of the diff — an independent, skeptical pass whose job is to *break* the change, not confirm it — then triage its findings, fix the real defects, re-run the gate, and only then commit / open the PR / merge / cut the release.

**Why this is a standing order, not a nicety.** The author and the author's tests share the same blind spots; an adversary with a fresh, hostile frame does not. A green suite is necessary, never sufficient — this repo has shipped, in one day, a test that asserted the defect it was written to prevent, a diagnostic that crashed only when it had something to report, and one instruction wrong in four separate string literals. Every one of those passed `--self-test`. **"Tests pass" earns the build; adversarial review earns the ship.**

---

## ⛔ First, the part specific to this repo: three defect classes, and only one is reachable by review

This is not a normal codebase. Its product is **instructions plus three scripts**, and its defects sort into three tiers by *who can possibly observe them*.

| tier | example from this repo | reachable by an adversarial reviewer? |
| :-- | --- | :-: |
| **Mechanical** | `regBad` computed and left out of the exit code · a TDZ in a `catch` · `*/` closing a comment twice · one instruction wrong in four string literals | ✔ **Yes** — and cheaply |
| **Generated-output** | the `x-update` notice omitting `--heartbeat` · a restart command naming the sender's absolute path · a self-test whose expectation was copied from the output | ✔ **Yes, but only if the reviewer GENERATES rather than reads** |
| **Outside-observer** | Markdown sent to a surface that renders `mrkdwn` · macOS shell/launchd behaviour · what a `/plugin` slash command does | ⛔ **No. Not by any agent, however adversarial** |

★ **The third tier is why this rule cannot be the whole discipline here.** The mrkdwn defect shipped for two days across hundreds of messages: the API returned `ok: true`, `--raw` showed exactly what was written, `--doctor` was clean, and the text read perfectly in every local tool. **The only surface that showed the damage was a human's screen.** A reviewer with the same tools would have confirmed it was fine.

> **A defect whose only observer is outside the system cannot be found by any amount of care inside it.**

So: run the review for tiers 1 and 2, and for tier 3 **name the observer you lack and go get them** — a human to look at a rendered message, a session on the other OS, a peer on a different machine. Recording "unverified on macOS" is a finding; guessing is not.

---

## How to apply

### 1 · Trigger

Any non-trivial change to `plugins/*/skills/*/*.mjs`, to a `SKILL.md`, or to the `README.md`'s install path. **A `SKILL.md` edit is a code change here** — the instructions *are* the behaviour, and a session follows what they say. Skip only for genuinely trivial mechanical edits.

⚠ **Documentation is not the low-risk category in this repo.** The four highest-cost defects this project has produced were all instructions: a restart command that leaves the reader invisible, a remedy that cannot work on the platform it names, an update procedure that updates nothing, and a credential check that leaks the credential.

### 2 · Sequence it: build → review → fix → *then* the gating run

The review changes the diff, so acceptance evidence gathered before it is evidence for code that is no longer shipping. **Do not announce, install, or tag until the review's findings are triaged.** Prepare the PR body while it runs.

⛔ **And commit the diff first, so the reviewer reads a stable tree** — but do not push a tag. A tag is the one artefact that is expensive to withdraw.

### 3 · Keep the reviewers out of the tree being validated

Prompt them read-only. In this repo the specific hazards are:

- **Running a script is a write to the shared Slack channel.** `slack-post.mjs`, `--announce-install` and `--retire` all post; `--retire` **deletes**. A reviewer "just checking whether it posts" leaves permanent artefacts on a bus other sessions are reading, and an `x-update` from a `+dev` tree is a message **nobody can later identify the build of**.
- **`--dry-run` is the safe probe** and exists for exactly this. It resolves declaration → `token_env` → registry → `auth.test` → binding and sends nothing.
- Give agents `isolation: "worktree"` if they must edit. ⚠ Note a linked worktree resolves to its **primary** checkout's plugin registration — see `--doctor`'s `REGISTERED` lines.

### 4 · Mechanism — a multi-agent `Workflow` review when orchestration is available

Spawn **N independent reviewers over the diff**, each with a **distinct lens chosen for this repo's actual risk surface**:

| lens | what it hunts |
| :-- | --- |
| **Generate, don't read** | Run every generator whose output changed and read the *delivered artefact*. `--announce-install` then `--show <ts>`; `--doctor` from a directory that triggers each ask. |
| **Sibling sweep** | The same instruction, constant or guard duplicated elsewhere. **Four of today's defects were a fix landing only where it was reported.** |
| **Unreached branches** | Every branch that fires *only* on failure. List them, force each, confirm it runs. A guard that has never fired has never been read. |
| **Credential paths** | Any operation that could expand, print or dump a secret. Two leaks in one day, both from an agent answering *"is the token set?"* |
| **Peer-machine claims** | Every sentence asserting something about a reader's machine, cache or version. |
| **Requirement fidelity** | The diff against the accepted criteria — **including the issue's comments**, not only its body. |

Prompt each to **refute**, default to skeptical, and pin what it must *not* relitigate. Force **structured findings** with a worked example verified against the code. Without orchestration, scale down to the same frame: a focused self-review under one lens at a time, which is still better than a general "look it over".

### 5 · Make the review real, not theatrical

Every finding must be **verified against the code, ideally by running it**. In this repo that has a sharp local meaning:

- ⛔ **Reading the code does not tell you what the tool says.** Fix a comment and leave the string, and the tool asserts `exits 1` while exiting 2 — four lines apart, in the same run.
- ⛔ **Reading a console summary does not tell you what was delivered.** Three of `#27`'s acceptance criteria were accepted, none reached the generator, and the code was "exercised" twice without its output ever being looked at.
- ⛔ **A `+dev` run has no subject anyone can obtain.** Verify against the **released** copy, or say plainly that the subject was an authoring tree.

### 6 · Triage and close the loop

Fix every blocker and major, and every cheap high-confidence minor.

- **Add a negative control for every real bug fixed.** Reintroduce the exact defect and confirm the suite goes red *for the right reason*. A green suite proves nothing until it has been shown to fail.
- ⛔ **A test whose expected value was copied from the output is not a test — it is a snapshot with an assertion attached.** The expectation must come from somewhere the implementation cannot reach: a spec, a platform fact, a `SKILL.md` section. This repo shipped a case reading `non-win32 says to restart the session` that **passed because the message said exactly that**, contradicting a `SKILL.md` shipped in the same release.
- **Every counter must reach both the summary and the exit code.** Verified by breaking one and watching the suite exit non-zero.
- **A pre-existing bug the change merely touches is in scope.** Fix it.
- **Re-run the gate**: `node <each script> --self-test`, `node --check`, and the markdown table validator, after the fixes.

### 7 · Re-verify the claims the change *makes*, not only the code it changes

⛔ **A fix that ships an assertion about the world ages independently of the code.** This repo shipped *"only one of these registrations is reachable"* in three consecutive releases — measured, correct at the time, and **false within the hour**, because both rows were subsequently moved by the same command. Nothing in the diff changed; the world did.

So when a change states a fact — *"no cwd can address this"*, *"the update moved only the upper-case row"*, *"this branch never fires"* — **re-run the measurement at ship time**, and prefer a form that degrades honestly: *"one run moves one row and nothing says which"* survives a second observation; *"only one is reachable"* does not.

★ This is the tier-3 problem wearing a different coat. The observation was sound and its **subject kept moving**, which no amount of reviewing the diff would surface.

### 8 · Record the verdict

A defect the review found and you fixed → the commit message, in the form the file uses (what was wrong, what it produced, what was measured). A finding you are **not** acting on → a GitHub issue, named rather than silent. A withdrawn claim → **banner the correction and keep the text**, so the next reader sees what was believed and why it failed.

---

## Tooling that raises the floor, so the review can reach the ceiling

The review is irreplaceable for novel reasoning. These catch the mechanical half, so its attention goes where only judgement works:

- **`--self-test` on all three scripts**, with the flag-in-`USAGE` invariant and the manifest `bot_user` invariant. ⚠ It has given a **false pass** before, by grepping the whole file instead of the usage string — a check that cannot tell *documented* from *merely mentioned*.
- **`node --check`** on every `.mjs` touched. It has caught a doubled `*/` twice.
- **The table validator** — `awk '$0 ~ /^>?[[:space:]]*\|/ { if ($0 !~ /\|[[:space:]]*$/) print "BAD ROW " NR }'` — after every `SKILL.md` edit.
- **Generate-and-`--show`** for any change to a generated message. This is the only tool that reads what a peer actually receives.
- **A `--dry-run` from two different working directories**, since the workspace verdict depends on whether a git root exists at all.

---

## The DRY line

This file is the standing statement of the discipline. The `Workflow` tool description holds the orchestration mechanics — adversarial verify, perspective-diverse lenses, loop-until-dry — don't restate them. The wire format, the claim protocol and the release loop live in `plugins/slack-as-claude/skills/slack-session-bus/SKILL.md`; the setup paths and the credential rule live in `plugins/slack-as-claude/skills/slack-as-claude/SKILL.md`. **This rule governs when to distrust a green run, not what the green run checks.**
