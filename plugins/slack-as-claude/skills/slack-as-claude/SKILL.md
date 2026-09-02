---
name: slack-as-claude
description: Use when a repo needs Claude to post into Slack, or to join one that already does — connecting to an existing Slack app, building one from scratch, or onboarding onto a clone someone else configured. Detects which of those states you are in before asking anything, covers the read-as-human / post-as-app identity split, and walks the human-only steps one at a time with the trap for each attached to it.
---

# Slack from a Claude session

**Goal: a Claude session in any repo can post into Slack under the app's own identity, and read the workspace as the human.**

# § 0. START HERE — **WORK OUT WHICH STATE YOU ARE IN. DO NOT ASK THE READER TO.**

## ★★★★★ **THIS SKILL IS INVOKED, NOT READ.** ### **So its first act is a PROBE, not a table someone has to match themselves against.**

# ⛔⛔ AND BE CLEAR ABOUT WHOSE JOB THIS IS: **YOU CANNOT PERFORM MOST OF THESE STEPS.**

### **Creating a Slack app, copying a token, running `setx`/`export`, and `/invite` are all HUMAN actions, outside the repo, in a browser and a terminal you do not drive.** # **Your job is: DIAGNOSE THE STATE, THEN WALK THE HUMAN THROUGH WHAT REMAINS, WITH CONCRETE VALUES ALREADY SUBSTITUTED.**

⚠ *Stating this stops the other failure — an agent trying to script around a step it cannot take.* ★ **"Run this command" is not delegation if you are the one who cannot run it.**

## THE PROBE — in this order, and it sends NOTHING

| **1** | **Does `<git root>/.claude/slack-workspace.json` exist?** ⛔ **If yes, this repo is bus-configured — DO NOT CONSULT `claude mcp list` AT ALL.** *It answers a question about the MCP half that a bus-only repo does not have.* **Read `token_env` and `team_id` out of it now; every placeholder below resolves from this file.** |
| :-: | --- |
| **2** | **Run the dry-run and read line 2.** *It resolves declaration → `token_env` → env/registry → `auth.test` → binding in ONE pass, and sends nothing.* |
| **3** | **Optionally, confirm the invite without posting:** `slack-watch.mjs --channel <CHANNEL_ID> --once`. ✔ **A bot that was never invited returns `not_in_channel`; a bad id returns `channel_not_found`; a member returns history.** *Measured across all three — so a missing `/invite` is detectable read-only.* |

```
node <plugin>/skills/slack-as-claude/slack-post.mjs --channel <CHANNEL_ID> --text x --dry-run
```

### **THE VERDICT LINE, AND WHAT EACH ONE MEANS:**

| `[matches <path>]` | ✔ **Configured and enforced. Nothing to do → §3 POSTING.** |
| :-- | --- |
| # ⚠ **`[no repo declaration - unenforced]`** | ### **THE TOKEN WORKS AND NOTHING IS PROTECTING IT.** *The repo declares no binding, so it will post to whatever workspace the machine's token belongs to and report `ok: true` doing it.* # **This is not "set up" — it is "set up and unguarded", and it LOOKS like success.** ✔ *Fix: write the declaration → §2. One file, no secret in it.* |
| **`[DOES NOT MATCH <path>]`** / **`WORKSPACE MISMATCH - refusing to send.`** | **Bound, and the token belongs to a different workspace.** *Fix whichever is wrong — the declaration or the variable. It REFUSES, so nothing has leaked.* |
| **`<TOKEN_VAR> is not set.`** | **No credential on this machine** *(or, on macOS/Linux, the session has not restarted)* **→ the stash step in SECTION A · 5.** |
| **plugin reported not installed** | `claude plugin install slack-as-claude@claude-skills` **→ SECTION A · 2.** |

## ⛔ **ONLY IF STEP 1 FOUND NO BINDING FILE AND THE READER WANTS THE MCP HALF** does `claude mcp list` mean anything:

| # **You only want the SESSION BUS** *(post · watch · claim between concurrent sessions)* | # **→ PATH BUS.** ### **Two bot scopes and an invite. Skip everything else in this file.** ★ *The scripts call six bot-token endpoints and nothing else — measured, not assumed, and two of them (chat.update, chat.delete) EDIT and DELETE messages.* |
| :-- | --- |
| # **You cloned a repo that ALREADY uses this** | # **→ SECTION A.** *Plugin install, your own app, token, invite, verify.* |
| # **New session in a clone that is already set up** | # **→ SECTION B. Nothing to do.** |
| # **Already working here, adding a SECOND WORKSPACE** | # **→ PATH SECOND.** *A second app, a distinct token variable, and a binding file. `claude mcp add` and the OAuth authorize are NOT repeated.* |
| **`slack … ✓ Connected`** | # **→ Nothing to install. Go to §3 POSTING.** *You need one thing only: the channel id.* ⚠ **`✓ Connected` does NOT guarantee the `mcp__slack__*` tools are exposed to your session** — *if they are absent, §3's human route gets you the id anyway.* |
| **Listed but `! Needs authentication`** | → **§7 WHEN IT BREAKS.** *Thirty seconds, not a rebuild.* |
| **Not listed, but the workspace already has the Slack app** | → **PATH A.** *New machine, existing app. Two commands.* |
| **Not listed, no app anywhere** | → **PATH B.** *First time in this workspace. ~20 minutes, mostly clicking.* |

# ⛔ **DO NOT run PATH B because a new repo "doesn't have Slack yet."** *The MCP registration and the OAuth authorize are machine-wide.*

## ⚠⚠ BUT "MACHINE-WIDE" IS NO LONGER TRUE OF THE WHOLE THING, AND THE OLD HEADER SAID IT WAS

### **It used to read: *"Both are MACHINE-WIDE — once one repo has done the setup, every other repo on that machine already has it."* # THAT PREDATES THE BINDING, AND IT POINTS A READER AWAY FROM THE SETUP THEY NEED.**

| **MACHINE-WIDE** *(still true)* | The `slack` MCP registration at `--scope user`, and the OAuth authorize behind it. |
| :-- | --- |
| # **PER REPO** *(the part that changed)* | ### **The DESTINATION — `.claude/slack-workspace.json`, committed, in the checkout.** ### **And with `token_env`, the CREDENTIAL too: a second repo naming `SLACK_BOT_TOKEN_B` has neither the destination nor the variable until someone sets them.** |

★ **So a second repo on the same machine is NOT automatically ready, and a reader told otherwise goes looking for a problem instead of doing the four steps in SECTION A.**

---

# § 0b. HOW TO WALK THE HUMAN STEPS — **ONE AT A TIME, WITH A CHECKPOINT**

## ★★★★★ **THE EIGHT GAPS IN THIS FILE'S PATH BUS WERE NOT FOUND BY READING IT. THEY WERE FOUND BY EXECUTING IT** — *one screen at a time, the human reporting what was actually there.*

### **And every one of them had the SAME SHAPE: the information existed somewhere in this file, and was not delivered at the moment it was needed.**

- *"AI agent is preselected"* — **useful BEFORE the click. Useless after.**
- *Trap 1 says the install fails* — **as a blanket warning it created the wrong expectation; at that screen, scoped to the manifest being pasted, it would have been right.**
- *The Verification Token sits unmasked* — **worth knowing BEFORE a screenshot.**
- *"OAuth Tokens is the third `h3`"* — **matters only in the second someone is scanning that page.**

# **A TRAP TABLE 400 LINES BELOW THE STEP IT APPLIES TO IS DOCUMENTATION. THE SAME SENTENCE DELIVERED ONE SCREEN EARLY IS A SAVE.**

| # **Present ONE step, then WAIT.** | *Do not dump the list. The human's report — a screenshot, an error string, "it says X" — is the input that advances the walkthrough.* |
| :-- | --- |
| # **Say what SUCCESS looks like.** | ### **After each action there is something observable: a dialog, a URL, an error, a token page. Name it, so a wrong turn surfaces AT THE STEP instead of three steps later.** ⚠ *Several of the eight gaps are exactly "the file never says what success looks like here".* |
| # **Attach the trap to ITS step.** | **In addition to the trap table, not instead of it.** |
| # **Say what to send back** | *when a step does not go as described.* |
| # **Substitute REAL VALUES.** | **You read `token_env` in the probe, so the instruction is `setx SLACK_BOT_TOKEN_ACME …`, never `setx <TOKEN_VAR> …`.** |

## ⚠ THE SKILL MUST HARD-CODE NO WORKSPACE'S VALUES — **BUT A PLACEHOLDER IS NOT A USABLE INSTRUCTION EITHER**

### **So every placeholder has a documented source, and the step before it says how to get it:**

| `<TEAM_ID>` · `<WORKSPACE>` | the repo's `.claude/slack-workspace.json`; else `auth.test` once a token exists |
| :-- | --- |
| `<TOKEN_VAR>` | that same file's `token_env` — **else `SLACK_BOT_TOKEN`** |
| `<CHANNEL_ID>` | the repo's own `CLAUDE.md` note *(§3 prescribes recording it)*; else **ask the human** |
| # `<CHANNEL NAME>` | # ⛔ **ASK. THERE IS NO CONVENTION AND THIS SKILL PRESCRIBES NONE.** *This project's own two workspaces use **different names** — `#bus` in one, `#claude-bus` in the other.* **Guessing produces a confident instruction to invite a bot to a channel that does not exist.** |
| `<APP NAME>` | chosen by whoever creates the app — **and in SECTION A that is the human you are talking to** |

---

# § A. **"I JUST CLONED A REPO THAT ALREADY USES THIS. WHAT DO I DO ON MY MACHINE?"**

### **Verified end to end, with the operator's corrections folded in.** ⚠ **Walk it one step at a time — §0b — and substitute the real `token_env`, app name and channel as you go.**

| **1** | **Open the repo in Claude Code.** *Trust is per-folder, persistent and one-time: a repo you have opened before needs no re-trust, and a committed `extraKnownMarketplaces` is picked up on the next session start regardless.* |
| :-: | --- |
| **2** | # ⛔⛔⛔ **WHO IS READING THIS DECIDES WHICH COMMAND EXISTS. THE TWO PATHS ARE NOT FALLBACKS FOR EACH OTHER.** <br><br> | **A HUMAN at the keyboard** | ✔ **`/plugin install slack-as-claude@claude-skills`** — *needs no CLI, so try it first.* | <br> | # **AN AGENT told "install the plugin"** | # ⛔ **THE SLASH COMMAND DOES NOT EXIST FOR YOU.** ### *It is USER-SIDE INPUT. No tool submits one, and asking the human to type it is a HAND-OFF, not an execution.* **The CLI is your ONLY path, not your fallback.** | <br><br> ⚠ *This is NOT the `/plugin isn't available in this environment` case below — that one is about a **fork lacking the command**. This one is about **who may issue it at all**, and it holds even where the command works perfectly.* <br><br> **CLI, in a terminal at the REPO ROOT:** `claude plugin install slack-as-claude@claude-skills` — *the marketplace must already be known: add it once with `/plugin marketplace add joshdaugherty/claude-skills`, or `claude plugin marketplace add` in a terminal.* ⚠ **The cwd does not register it.** *This line used to say the repo root mattered "because the marketplace is registered by the repo's own `.claude/settings.json`" — **there is no such file in this repo, and there never has been.** <br><br> ⛔⛔ **AND `install` IS FOR A PLUGIN YOU DO NOT HAVE. IT DOES NOT UPDATE ONE.** *It populates a cache directory and moves no registration —* **measured: 39 runs, 39 directories, zero registrations moved, a real success line every time.** ✔ **To UPDATE, see §7: `claude plugin update <plugin>@<marketplace>`, and again with `--scope project` for every repo-enabled entry.** <br><br> ✔ **CHECKPOINT — THREE DIFFERENT FAILURES, THREE DIFFERENT FIXES. Read which one you got:** <br> ⚠ **`Unknown skill`** → *the install is probably fine and the SESSION is stale.* Try `/reload-plugins`; if it still does not resolve, **RESTART THE SESSION**. ⛔ *Do not debug the install on the strength of `claude plugin list` — it reports `✔ enabled` for a correctly installed plugin a running session cannot yet see* (→ §7). <br> ⚠ **`/plugin isn't available in this environment`** → *you are in a VS Code FORK.* **Observed in Cursor at two extension versions (2.1.246 and 2.1.252), so within that range it is NOT version-dependent.** ⛔ *No data on Windsurf, VSCodium or Positron — do not generalise "forks" from one fork.* **Use the CLI fallback.** <br> # ⚠⚠ **AND YOU CANNOT TELL WHICH EDITOR YOU ARE IN FROM YOUR OWN ENVIRONMENT BANNER.** ### **A session running in CURSOR reports *"You are running inside a VSCode native extension environment"* — that string is the extension's generic self-description, not a fork discriminator — and `TERM_PROGRAM` is unset.** ⛔ *So an agent asked "which editor is this?" will answer **VS Code**, confidently and wrongly.* ✔ **The extension PATH discriminates:** `~/.cursor/extensions/anthropic.claude-code-…` *vs* `~/.vscode/extensions/…`. <br> ⚠ **`claude: command not found`** → **THE IDE EXTENSION DOES NOT INSTALL A CLI.** *A machine can have a current extension and no `claude` binary anywhere — an ordinary state for anyone who installed the editor extension and nothing else.* **Install the CLI** *(`brew install claude-code`, or the setup docs)*, **or use `/plugin` if your editor has it.** <br><br> ⛔ **If you are in a fork AND have no CLI you have NEITHER path** — that is the case this step used to leave with no exit at all. |
| **3** | # **CREATE YOUR OWN APP — → PATH BUS.** ### **So the bus can tell people apart.** ⛔ *A shared token gives everyone ONE identity, collective rotation, and no way to revoke a single person.* ⚠ **Edit TWO manifest fields to your own name before pasting — `display_information.name` AND `features.bot_user.display_name` — and make them distinct from every teammate's.** |
| **4** | **Get the token:** *Go to App Settings → **OAuth & Permissions** → under the **`OAuth Tokens`** heading → **Bot User OAuth Token** (`xoxb-…`).* ⚠ **NOT at the top of that page.** |
| **5** | # **STASH IT — IN YOUR OWN TERMINAL, NEVER PASTED INTO A CHAT.** *(the two forms below are NOT variants of one command)* |
| **6** | **In Slack, in the workspace, in the channel: `/invite @<APP NAME>`.** *Per-channel and permanent.* ⛔ **Ask which channel — do not assume a name.** |
| **7** | # **NAME THE MACHINE — `setx CLAUDE_SLACK_MACHINE "josh-laptop"`** *(macOS/Linux: `export`, in the profile)*. ### **Skip this and every message from this machine is stamped with the raw OS hostname — `DESKTOP-HBNGBFQ`.** ⚠ *On a bus whose entire purpose is telling senders apart, that is noise, not signal* — **and §6 already says exactly this about container hostnames.** ★ *One value per machine, so an environment variable is genuinely the right home for it — unlike the session label.* |
| **8** | **Verify with the §0 dry-run. Nothing is sent. Line 2 must say `[matches …]`.** |

# ⚠⚠ AND IF THIS MACHINE WILL RUN **MORE THAN ONE SESSION AT A TIME** — *one per worktree, say* — **DO NOT SET `CLAUDE_SESSION_NAME`.**

### **It is machine-wide, so all of them would announce the same label and collapse into one roster row.** # **Pass `--session <label>` per invocation instead.**

## ★★★★★ **AGREE A NAMING CONVENTION BEFORE THE SECOND PERSON JOINS — NOT AFTER THE FIRST COLLISION**

### **A label only has to be unique across everything that might post to the channel, and on a shared bus that is `session × machine × PERSON`.** ⚠ **A convention that works for one developer's two worktrees breaks the moment a colleague clones the same repo and picks the same obvious lane names** — *`main`, `docs`, `worker-1` are exactly the names two people choose independently.*

| # **1 · Put the PERSON in the machine alias** | `setx CLAUDE_SLACK_MACHINE "josh-laptop"` ### **One value per machine, so the environment variable is the right home — and folding in the name or handle makes every machine on the bus unambiguous across people, not just across boxes.** ⚠ *`DESKTOP-HBNGBFQ` identifies neither.* |
| :-- | --- |
| # **2 · Then make the SESSION label carry what varies within that machine** | ### **`<worktree>-<machine>`** *when sessions map to worktrees — `r-branch-josh-laptop`* <br> ### **`<purpose>-<machine>`** *when they map to jobs — `indexer-josh-laptop`* # **Pass it as `--session`, every invocation.** |

✔ **Why the pair works: the two halves are unique on different axes, so the product is unique without anyone coordinating.** *The machine half is set once per box by whoever owns it; the session half is chosen locally and only has to be unique within that box.* # **NOBODY HAS TO CONSULT A REGISTRY, AND THAT IS THE POINT — a convention that needs central allocation will not be followed.**

## ⛔ **RECORD THE CHOSEN CONVENTION IN THE REPO'S `CLAUDE.md`, BESIDE THE CHANNEL ID.**

### *It is a per-repo agreement, not a per-person preference, and the next person to clone has no way to infer it.* ⚠ **An unwritten convention is not a convention** — *it is whatever the first person happened to type, and the second person will not guess it.*

## ⚠⚠ STEP 5 IS PER-OS, AND `setx` IS WINDOWS-ONLY

| # **Windows** | `setx <TOKEN_VAR> "xoxb-..."` ### ✔ **Effective immediately**, *because the scripts fall back to reading `HKCU\Environment` when `process.env` does not have it.* |
| :-- | --- |
| # **macOS / Linux** | # ⛔ **`setx` DOES NOT EXIST.** <br><br> ### **1 · FIND OUT WHICH SHELL IS ACTUALLY RUNNING. DO NOT GUESS, AND DO NOT OFFER THE READER A CHOICE:** <br> `basename "$(ps -p $$ -o comm=)"` → **`zsh` → `~/.zshrc`** · **`bash` → `~/.bash_profile`** <br> ⚠⚠ **THE `basename` IS NOT OPTIONAL.** *Measured on macOS: `ps -p $$ -o comm=` prints **`/bin/bash`**, an ABSOLUTE PATH — so `case "$(ps …)" in zsh) … bash) … esac` matches **NEITHER ARM** and falls silently through.* <br> ⛔⛔ **AND DO NOT FALL BACK TO `$SHELL`.** *It is the login shell from the passwd entry, **not the shell that is running**. On a machine whose login shell is `zsh` while the harness spawns `bash`, `$SHELL` names the file that will NOT be sourced —* # **which is precisely the bug this step exists to prevent.** *It agrees with `ps` only when the two happen to coincide.* <br> ★ *Free tell in any terminal paste: **`zsh` prompts with `%`, `bash` with `$`**.* <br><br> ### **2 · Add `export <TOKEN_VAR>="xoxb-..."` to THAT file.** <br><br> # ⛔⛔⛔ **3 · AND DO NOT TELL ANYONE TO "RESTART THE SESSION". ON macOS IT IS NOT A WEAKER FIX — IT IS NOT A FIX.** <br><br> ### ✅ **MEASURED on macOS 26.6.2 / Cursor:** *the harness shell is **non-login** (`shopt -q login_shell` → 1) **and non-interactive** (`$-` → `hBc`), so it sources no profile of its own.* <br> # **AND RESTARTING DOES NOT REACH IT EITHER, WHICH IS THE DECISIVE PART:** <br> ### **The SESSION restarted at 08:54 against an export written at 08:52 and still could not see it — because it inherits from the extension host, itself running since 08:42 SEVEN DAYS EARLIER, under an editor launched from the GUI with an environment from `launchd`.** <br> `44201 ← 40125` *09:26 `bash`* · `40125 ← 1722` *Sep 2 08:54 `claude`* · `1722 ← 1262` *Aug 26 08:42 `extension-host`* · `1262 ← 1` *Aug 26 08:42 `Cursor`* <br> # **THE RESTART NEVER CROSSED THE BOUNDARY WHERE THE ENVIRONMENT IS ESTABLISHED.** ⛔ *A GUI-launched application never reads a shell profile, at launch or afterwards, and nothing beneath it can.* <br><br> ⚠⚠ **AN EARLIER DRAFT OF THIS ROW CALLED THE 08:54 PROCESS "THE EXTENSION HOST". IT WAS THE SESSION.** *The probe behind it was `ps -p $PPID`, which returns **exactly one level** and answers "what launched this shell".* # **ONE LEVEL OF A FOUR-LEVEL CHAIN, REPORTED AS THE WHOLE CHAIN — AND IT READS IDENTICALLY TO A CORRECT RESULT, WHICH IS HOW IT SURVIVED INTO A MERGED FILE.** ★ *Walk the chain to PID 1, or you are naming whichever process you happened to look at first.* ✔ **The conclusion SURVIVES and the correct attribution STRENGTHENS it:** *"a restart did not help" was an observation; "the restart never crossed the boundary" is a reason.* <br><br> ✔ **THE ONE REMEDY MEASURED WORKING END TO END:** `bash -lc 'node …/slack-post.mjs …'` — *token and `CLAUDE_SLACK_MACHINE` both resolved, a live post succeeded, no restart of anything.* ⚠ *Untested: a profile that guards on `[[ $- == *i* ]]` or returns early on `PS1` would be skipped by a login-but-non-interactive shell and defeat this. The machine measured had no such guard.* <br><br> ✔ **`launchctl setenv` PROPAGATES — MEASURED.** *It sets the `launchd` environment, is correctly **invisible** to an already-running app, and an app launched **afterwards** does inherit it.* ⛔ **It still does not survive a reboot — persisting it needs a LaunchAgent, so it is a WITHIN-SESSION mechanism, not a durable alternative to a profile export.** <br><br> # ⛔⛔⛔ **AND THE WAY THAT WAS MEASURED IS WORTH MORE THAN THE RESULT: THE FIRST RUN WAS A FALSE NEGATIVE THAT LOOKED EXACTLY LIKE A FINDING.** ### **Probed against `Calculator`, the variable came back `ABSENT` — from a dump of 61 characters containing ZERO variables, because `ps -E` cannot read the environment of a SIP-protected Apple binary.** *`USER` and `HOME` were "absent" too.* # **WITHOUT A POSITIVE CONTROL THAT WOULD HAVE BEEN REPORTED AS "launchctl DOES NOT PROPAGATE" — THE EXACT OPPOSITE OF THE TRUTH.** <br> ✔ **So: any `ps -E` probe on macOS needs a KNOWN-PRESENT variable checked alongside the one under test, and a THIRD-PARTY binary as the target.** <br><br> ⚠ *And a second trap in the same test: `open` also propagates the CALLING SHELL's environment, so an `open`-launched process is not a clean model of a Dock-launched one. The result holds only because `launchctl setenv` provably does not touch the calling shell — verified directly — so the variable could only have arrived via `launchd`.* ⛔ *Bounded: measured against a third-party app, not the editor itself.* <br><br> ★ **BOUNDED, AND THE SESSION THAT MEASURED IT SAID SO FIRST:** *one macOS machine, one editor, one day. It establishes the mechanism; it does not establish that every macOS harness is non-login — an editor launched **from a terminal** would inherit that terminal's environment and behave completely differently.* <br><br> ⛔⛔ **THE OLD WORDING SAID "`~/.zshrc` or `~/.bashrc`" AND COST FOUR ROUNDS ON ONE MACHINE.** *Both exports landed in `~/.zshrc` on a machine running **bash**, so the shell never sourced them.* # **AND THE FAILURE MIMICS A DIFFERENT CAUSE:** *the probe says `<TOKEN_VAR> is not set`, which reads as **"the export did not take"** rather than **"the export went into a file this shell never reads"** — so the natural response is to run the same export again, reproducing it exactly.* <br><br> ⚠ **`~/.bashrc` IS THE WRONG FILE ON macOS EVEN WHEN THE READER IS ON BASH:** *an interactive login shell reads `~/.bash_profile`, and `~/.bashrc` is frequently absent entirely.* ✔ **Writing to both is harmless insurance** — *an IDE's integrated terminal may spawn a different shell than Terminal.app.* <br><br> # ★★★ **AND STATE THE ASYMMETRY PLAINLY, BECAUSE IT EXPLAINS WHY NOBODY SAW ANY OF THIS:** ### **WINDOWS HIDES THE ENTIRE PROBLEM.** *`botToken()` falls back to `HKCU\Environment` when `process.env` is empty, so a Windows session finds the token no matter what shell spawned it.* # **THE PLATFORM WITH THE WEAKER ENVIRONMENT STORY IS THE ONE WITH LESS TOOLING** — *and every author of this file so far has been on the platform that cannot see the failure.* ⚠ *Same asymmetry §2 records for the identity variables.* |

★ **`<TOKEN_VAR>` is not a placeholder you leave in.** *You read it from the repo's `token_env` during the probe, so what you present is `setx SLACK_BOT_TOKEN_ACME "xoxb-..."`.*

---

# § B. **"NEW SESSION, IN A CLONE THAT IS ALREADY SET UP. IS THERE ANYTHING TO DO?"**

# ✔ **NO. NOTHING.** ### **Say so plainly, because the routing table used to imply otherwise.**

### **The app exists, the bot is already in the channel, the channel id is recorded in the repo, and the token is on the machine.** **One dry-run confirms it** *(§0 — it sends nothing)*, **and §0's verdict table covers every way it can come back wrong.**

# ⛔ **DO NOT RUN PATH A OR PATH B HERE.** ### *Both create or connect an app that already exists.* ⚠ **This is the single most likely wrong turn in the whole file, because the old triage keyed on `claude mcp list` — which shows NOTHING for a bus-only setup, and so routed a perfectly configured repo to "set it up from scratch".**

---

# 1. THE ONE FACT THAT FORCES THE DESIGN

# ⚠ `mcp.slack.com` IS USER-TOKEN-ONLY. THERE IS NO BOT PATH.

Its OAuth discovery metadata advertises only the `v2_user` endpoints — `slack.com/oauth/v2_user/authorize` and `oauth.v2.user.access`. **There is no bot authorization endpoint to point a bot token at.** *Verify any time:*

```
curl -s https://mcp.slack.com/.well-known/oauth-authorization-server
```

★ *Proven with a negative control:* **a placeholder string returns `invalid_token`; a genuine `xoxb-` bot token returns `invalid_token_type`.** *The error changes — Slack parses the bot token and refuses it on TYPE, not validity.* **Without the placeholder run first the second result would only be suggestive. The pair is conclusive.**

## ⛔ So do not propose, and do not retry:

- **bot scopes on the manifest to make MCP post as an app** — cannot work
- **a `--header "Authorization: Bearer xoxb-…"` server entry** — 401 `invalid_token_type`, every time
- **Claude Tag as the fallback** — *it does post under its own identity, but it is a different product, Team/Enterprise only.* **Check the plan before raising it.**

## ★ Hence the split — which is the correct shape, not a compromise

| # **READ as the human** | The 19 `mcp__slack__*` tools, on their user token. **Sees everything they can see.** |
| :-- | --- |
| # **POST as the app** | The bundled `slack-post.mjs` → `chat.postMessage` on the **bot** token. **Lands with an `APP` badge, as a different user id.** |

- **Route reads through the bot instead** and the agent goes blind to most of the workspace — *a bot only sees channels it was invited to.*
- **Route posts through the user token instead** and every agent message is **indistinguishable from the human** in Slack's audit trail. *No badge, no "via app" — months later they cannot tell what they wrote from what the agent wrote.*

---

# ⛔ THE CREDENTIAL RULE — APPLIES TO BOTH PATHS

# **A `xoxb-` token, a client secret, an OAuth code and the VERIFICATION TOKEN are credentials. NONE may enter the transcript.**

# ⛔⛔⛔ AND THAT SENTENCE FORBIDS AN **OUTCOME** WHILE §0's PROBE MANDATES AN **OPERATION**. NAME THE OPERATIONS, OR THEY GET IMPROVISED.

### **Twice in one day, by two different sessions, the leak came from an agent trying to answer "is the token set?" — a question this file REQUIRES be answered and never said how to answer.**

## ✔ THE ONLY SANCTIONED CHECK:

```
node <plugin>/skills/slack-as-claude/slack-post.mjs --channel <id> --text x --dry-run
```

### **It resolves the credential, prints `<TOKEN_VAR> is not set.` when absent, and NEVER ECHOES IT when present.** # **The value is never expanded, so there is nothing to leak.**

## ⛔ NEVER, EVEN "JUST TO CHECK":

| `echo $VAR` · `printenv` · `env` | **prints it** |
| :-- | --- |
| # `${VAR:-fallback}` | # ⚠⚠ **RETURNS THE VALUE WHEN SET.** *It substitutes the fallback only when UNSET.* **`"${VAR:+SET}${VAR:-UNSET}"` looks like it partitions and does not — the set case prints `SET` AND THE SECRET.** *That exact line put a live bot token in a transcript.* |
| # `reg query HKCU\Environment` *(whole key)* | # **DUMPS EVERY VALUE, INCLUDING TOKENS YOU WERE NOT LOOKING FOR.** *This one leaked two unrelated credentials at once — the variable under test and a Hugging Face token nobody was thinking about.* |
| passing it as a CLI argument | *lands in process listings and shell history* |

## ★★★ AND A REDACTION FILTER DOES NOT PROTECT YOU HERE — IT **STRUCTURALLY CANNOT**

### **A `sed` filter covers bytes flowing through a PIPE. A SHELL EXPANSION IS A DIFFERENT PATH: the value is interpolated BEFORE any filter exists.** ⚠ *And the trap is that both appear in the same session — an agent watches its redaction correctly mask a token in `grep` output, and reasonably concludes it is protected on the next line. It is not.*

# ✔ **IF YOU GENUINELY MUST TEST SET-NESS WITHOUT THE SCRIPT, TEST WITHOUT EXPANDING:** `[ -n "${VAR+x}" ] && echo set || echo unset` *· or a length alone, `${#VAR}`.* ⛔ **Both are worse than the dry-run, which answers the question you actually have.**

## ⚠⚠ **AND THE ONE THAT ACTUALLY LEAKS IS THE ONE NOBODY GUARDS: `Basic Information` RENDERS THE VERIFICATION TOKEN IN PLAINTEXT.**

### **Client Secret and Signing Secret are dotted out on that page. The Verification Token is NOT.** # **So a screenshot of `Basic Information` — the ordinary way a human shows you a settings page — leaks a live credential while the two obvious ones stay safe.** ⚠ *Hit for real: the page was screenshotted during a setup walkthrough and the token went into a transcript.*

★ **Low severity — it is deprecated, and it only verifies inbound requests to endpoints a bus-only app does not have.** *But it is zero-cost to warn about, and screenshot-driven walkthroughs are exactly how this file gets used.* # **SAY IT BEFORE THEY SCREENSHOT THAT PAGE, NOT AFTER.**

*The pattern that works:* **the user runs the command carrying the secret, in their own terminal, and reports only that it is done.** *You read the result from `claude mcp list`, which shows errors but never values.*

⚠ **You cannot run `claude mcp add --client-secret` for them.** *The agent shell is non-interactive with stdin on the null device; the prompt reads EOF and fails.*

---

# ★★★★★★ PATH BUS — **YOU ONLY WANT THE SESSION BUS. YOU NEED NONE OF THE MCP SETUP.**

### **MEASURED, not assumed. The complete set of Slack endpoints all three scripts call:**

```
auth.test  ·  chat.postMessage  ·  chat.update  ·  chat.delete  ·  conversations.history  ·  conversations.replies
```

## **All six are BOT-token endpoints. There is no `mcp__slack__` call and no user token anywhere in the scripts.**

# ⚠⚠ **TWO OF THEM MODIFY AND DELETE MESSAGES, AND THIS LIST USED TO OMIT BOTH.**
### **`chat.update`** is called on **every heartbeat tick after the first** *(the presence refresh)*, and
**`chat.delete`** on **every presence message `--retire` removes.** *They are reached through a
`slackPost(method, …)` indirection rather than a literal URL, which is why a grep for
`slack.com/api` found four and the enumeration inherited that number.*
# **If you are the admin approving this app, that is the sentence you needed and were not given.** ⛔ **So routing a bus-only reader through PATH B — twenty user scopes, the Agents/MCP toggle, `claude mcp add`, the OAuth authorize, a matching callback port, and B4b's reinstall — imposes THIS FILE'S OWN WORST TRAP on a use case that needs two bot scopes.**

### ✅ **THE STEPS BELOW ARE FROM AN EXECUTED RUN, SCREEN BY SCREEN — not from reading the wizard.** *Every correction in them was paid for once.* # **Walk them ONE AT A TIME with the human, and confirm what they are seeing before advancing.**

| **1** | `api.slack.com/apps` → **Create New App**. ⚠ **A dialog of four tiles opens with "AI agent" ALREADY SELECTED.** *You want **From a manifest**, bottom-left under "Or start your own way".* # **Click that tile, THEN click `Continue` — the tile alone does not advance.** |
| :-: | --- |
| **2** | ⚠ **The paste box and the workspace picker are ONE screen (`Step 1 of 2`), not two.** *The workspace dropdown sits **BELOW** the JSON box, where it is easy to scroll past.* **Paste `slack-app-manifest_bus-only.json`** *(the file beside this one — copy it, do not retype)*, **pick the workspace, `Next`.** *`Step 2 of 2` is a review screen: check the scopes, `Create`.* |
| **3** | **Click `Create and Install` once, and approve on the `Allow` screen.** ✔ **For THIS manifest it SUCCEEDS** — *see trap 1, which is scoped to manifests that carry `redirect_urls`; the bus-only one does not.* ⛔ **There is NO separate "Install to Workspace" step to hunt for** — the wizard ends in this one button. |
| **4** | **The success dialog says "\<app\> is ready!" and then offers four Slack CLI steps** — *`Install Slack CLI` → `slack login` → `slack create` → `slack run`.* # ⛔ **IGNORE ALL FOUR. That is Bolt scaffolding for a different kind of app; the bus uses the bot token directly.** ✔ **Click `Go to App Settings`.** |
| **5** | **→ OAuth & Permissions → under the `OAuth Tokens` heading → Bot User OAuth Token (`xoxb-…`).** ⚠ **NOT at the top of that page** *(→ navigation note below)*. **The human stashes it under this repo's `token_env`** *(or `SLACK_BOT_TOKEN` if it declares none)* **in their OWN terminal → §2.** |
| **6** | # **ASK THE HUMAN WHICH CHANNEL, AND DO NOT ASSUME A NAME.** ### *There is no conventional name and this skill deliberately prescribes none — one workspace of this project's own uses `#bus`, another uses `#claude-bus`.* **Then, in Slack, in that channel: `/invite @<app name>`.** *Per-channel and permanent. A bot that is not a member cannot post, and the error does not say so plainly.* |
| **7** | **Get the channel id — ask the human** *(§3, and it is five seconds)*. **Then verify with a `--dry-run`, which sends nothing.** |

### **That is the whole path.** *No MCP server, no user token, no OAuth flow, no callback port, no reinstall, no trap 5.* ✔ **`--doctor`, `--presence`, `--ping`, claiming and posting all work on this alone** — *all of those live in `slack-session-bus/slack-watch.mjs`, not in this skill's script.*

## ⚠ NAVIGATION — **`api.slack.com/apps` IS THE ENTRY POINT, BUT THE SETTINGS UI IS NOT THERE ANY MORE**

### **Clicking into an app lands you on `app.slack.com/app-settings/<team>/<app>/…`.** *Every `→ OAuth & Permissions → <thing>` instruction in this file means that UI.* # ⚠ **ON `/oauth`, `OAuth Tokens` IS THE THIRD `h3` ON THE PAGE — NOT THE TOP.** ### *An earlier draft said "top of that page" and the operator was sent to the wrong place.* **Say "under the `OAuth Tokens` heading", never "at the top".**

⚠ **This also puts TRAP 5's landmark in doubt** — *its fix is "scroll UP to OAuth Tokens, further up the same page", which is a claim about a layout that may no longer hold.* # **UNVERIFIED against the current UI. It is the most expensive trap in this file, so re-verify it on the next scope change rather than trusting the direction word.**

⚠ **YOU GIVE UP READING AS YOURSELF.** *Search, canvases, DMs, reading channels the bot is not in — all of that is the MCP half. Add it later via PATH B if you want it; nothing here has to be undone.*

---

# ★★★★★ PATH SECOND — **SAME MACHINE, ALREADY WORKING, ADDING ANOTHER WORKSPACE**

### **PATH A is *existing app, NEW machine*. This is the inverse, and 2.13.0's binding exists for it.** ⚠ *A Slack app is bound to ONE workspace — Slack says so at creation: **"This can't be changed later."** So a second workspace means a second app, from the same manifest file.*

| **NOT needed** | *`claude mcp add`* · *the OAuth authorize* · *the callback port* — **all machine-wide and already done.** ⛔ **Do not re-run them: `--scope user` is one registration, and a second authorize would move it, not add one.** |
| :-- | --- |
| **Needed** | **1.** New app in workspace B from the manifest file · **2.** Install · **3.** Stash its bot token under a **DISTINCT** variable, e.g. `SLACK_BOT_TOKEN_B` · **4.** `/invite` the bot · **5.** Declare the binding in repo B |

```json
// <repo-B>/.claude/slack-workspace.json
{ "team_id": "T0…B", "team": "B", "token_env": "SLACK_BOT_TOKEN_B" }
```

### **`team_id` comes from `auth.test` on that workspace's token.** ✔ *Repo A keeps working untouched — it declares nothing, or declares A, and neither repo can post to the other's workspace: a mismatch REFUSES with exit 2.*

# ★★★★ AND WHEN YOU DO ADD A SECOND READ WORKSPACE: **TAKE `slack` OFF `--scope user` FIRST**

### **`--scope user` means ONE registration visible in EVERY repo.** *Add a second at project scope and repo B sees both — so a session in repo B can read workspace A as you.* # **That contradicts the one-repo-one-workspace rule the POSTING side enforces with a refusal**, *and nothing on the read side refuses anything.*

## ✔ **THE END STATE: no user-scope Slack MCP at all. Each repo registers its own at `--scope local`** *(the DEFAULT), which lives in `~/.claude.json` under `projects/<dir>/mcpServers` — **per-project, private to the machine, and not committed.***

# ⚠ **`local`, NOT `project`.** ### **`--scope project` writes `.mcp.json` INTO the checkout** — *so it is committed, shared with anyone who clones, and gated behind a per-project approval prompt.* **Same isolation, and it publishes your MCP config.** ⛔ *An earlier draft of this section said `project`. It was wrong.*

## ★ **AND THE RE-AUTH RISK IS SMALL, BECAUSE THERE IS A COMMAND FOR IT:**

```
claude mcp remove slack --scope user
claude mcp add --transport http slack https://mcp.slack.com/mcp    # local is the default
claude mcp login slack                                             # only if the credential did not carry
```

### ✅ **MEASURED, ON A REAL MIGRATION:** *the credential key is `<server-name>|<hash>` and it came back **BYTE-IDENTICAL** across a user → local move.* **So the hash covers the NAME and URL, not the scope — a scope change does not invalidate it.**

# ⛔ **WHAT ACTUALLY COSTS YOU IS `remove`, NOT THE SCOPE CHANGE.** ### **`claude mcp remove` clears BOTH the access token AND the stored client config** — *and `mcp.slack.com` does not support dynamic client registration, so re-adding needs the Client ID and Secret again:*

```
claude mcp add --transport http slack https://mcp.slack.com/mcp   --client-id <id> --client-secret --callback-port 8765     # prompts for the secret
claude mcp login slack
```

⚠ **`--client-secret` TAKES NO VALUE — IT PROMPTS.** *Which is why an agent cannot run this step: a non-interactive shell reads EOF and the add fails.* ⚠ **And `--callback-port` must match the manifest's redirect URL**, *or Claude Code picks a random port and the redirect will not match.*

★ **SO ADD THE NEW REGISTRATION BEFORE REMOVING THE OLD ONE** — *the key survives, and never being without it is free.* ⛔ *Three estimates of this cost were published before it was measured: "probably survives", then "always costs a full re-add", then the measurement. The first two were inference and the file said so; only the third is worth following.*

# ★★ **DO IT BEFORE YOU ADD THE SECOND WORKSPACE, NOT AFTER.** ### *One server to move, one credential at risk, and the flow you might re-run is against the workspace you are already signed into.* ⚠ *Afterwards means untangling two.*

---

# ⛔⛔ THE MCP **READ** PATH REMAINS SINGLE-WORKSPACE, AND THAT IS NOT SOLVED

### **One `slack` MCP server at `--scope user` = one workspace you can read as yourself.** *Whether two `mcp.slack.com` registrations can hold different workspace authorizations at once is **UNVERIFIED** — stated rather than guessed.* # **Workspace B can be POSTED to correctly, or REFUSED. It cannot yet be READ.** ★ *For a bus-only second workspace this costs nothing, because the bus never reads as you.*

---

# PATH A — CONNECT (existing app, new machine)

**You need from the user: the app's Client ID, its Client Secret, and the Bot User OAuth Token.** *All three are on `api.slack.com/apps/<app id>` — Client ID and Secret under **Basic Information**, the bot token under **OAuth & Permissions**.*

**A1.** The user runs, in their own terminal:

```
claude mcp add --transport http slack https://mcp.slack.com/mcp --scope user --client-id <id> --client-secret --callback-port 8765
```

*The `--callback-port` must match a redirect URL already registered on the app. If the app was built with this skill it is `http://localhost:8765/callback`.*

**A2.** `/mcp` → `slack` → authenticate. # **Then RESTART the session** *(→ trap 4).*

**A3.** The user stashes the bot token — *`setx` on Windows, `export` in the profile elsewhere* → **§2**. ⚠ **UNDER THE NAME THE REPO DECLARES**, *not `SLACK_BOT_TOKEN` by reflex — see the box in §2.*

# ✔ **Done. No Slack UI needed at all.**

---

# PATH B — SET UP FROM SCRATCH

## B1 · Create the app from a manifest

`api.slack.com/apps` → **Create New App** → **From a manifest** → paste → **pick the workspace** → *Step 1 of 2*.

⚠ **Same two wizard snags as PATH BUS step 1–2, and they cost the same time here:** *the tile dialog opens on **"AI agent"**, so **From a manifest** (bottom-left, under "Or start your own way") must be clicked **and then `Continue`**; and the **paste box and workspace dropdown are the SAME screen**, with the dropdown **below** the JSON where it is easy to scroll past.*

# ★★★ THE MANIFEST IS A FILE IN THIS SKILL, NOT A BLOCK IN THIS DOCUMENT.

### **`slack-app-manifest.json`, beside this file.** *It was inline here and is not any more, because a manifest that exists twice drifts — and this project has spent two days on exactly that failure.* # **Copy the file. Do not retype from prose.**

⚠ **IT NOW CARRIES BOT SCOPES AS WELL AS USER SCOPES, AND THAT IS THE FIX FOR A TRAP THE ORIGINAL CAUSED.** ### *The first version had 21 user scopes and **zero** bot scopes — so posting as the app did not work, the bot scopes were added by hand afterwards, and that edit is a scope change, which forces a reinstall and **rotates both tokens** (→ trap 3).* # **A NEW app created from this manifest gets them at install time, in one pass, with no reinstall.**

| `user` | 21 read-leaning scopes plus `chat:write` — what the **MCP server** uses, acting as you |
| :-- | --- |
| `bot` | `chat:write` · `channels:history` · `groups:history` — what **`slack-post` / `slack-watch` / `slack-claim`** use |

### **The bot set is derived from the five SCOPED API methods the scripts actually call** — `chat.postMessage` · `chat.update` · `chat.delete` · `conversations.history` · `conversations.replies` — *not from guessing generously.* ⛔ `chat:write.customize` *is deliberately absent: it is only needed for a custom display name or avatar, and adding it is a scope change for a cosmetic feature.* *`groups:history` is there so a **private** bus channel works; drop it if yours is public.*

- **`http://localhost:8765/callback` is plain HTTP and Slack accepts it.** *The HTTPS requirement has a localhost carve-out. Do not reach for ngrok or a tunnel.*
- **The port is arbitrary but must match `--callback-port` forever after.** *Otherwise Claude Code picks a random port and the redirect will not match.*
- **USER scopes deliberately** — read-leaning plus `chat:write`. *Adding `channels:write` / `files:write` / `canvases:write` lets the agent restructure the workspace. Start without; add on request.*
- **Only directory-published or internal apps may use MCP.** *An unlisted app is refused.*

# ⚠⚠ CLICK "Create and Install" **ONCE** AND EXPECT IT TO FAIL → *trap 1*

### **Here it genuinely does fail, and the reason is THIS manifest's `redirect_urls`** — *`http://localhost:8765/callback`, which only Claude Code can answer.* ⚠ **That is a property of the manifest, not of the button:** *the bus-only manifest declares no redirect and its install succeeds.* # **So do not carry "the install always fails" into PATH BUS — say WHY it fails, and the reader can tell a real failure from this one.**

## B2 · Turn on the toggle that actually matters

# **Agents → "Slack Model Context Protocol (MCP) Server" → On.** *(sidebar → **Features** → **Agents**; the URL ends `/app-assistant`)*

*Until this is on, every connection returns* `App is not enabled for Slack MCP server access` — *which reads like an auth failure rather than a missing switch.* # ⛔ **NOT the sidebar's "MCP Servers" page** → *trap 2*

# ⚠⚠ AND THERE ARE **TWO TOGGLES ON THAT PAGE**. THE ONE YOU WANT IS THE **SECOND**.

| **Agent experience** | *"power your app's conversational AI agents"* — **LEAVE IT OFF.** ⛔ *Nothing to do with MCP, sits directly ABOVE the one you want, and flipping it changes nothing you can see — so it fails silently and looks done.* |
| :-- | --- |
| # **Slack Model Context Protocol (MCP) Server** | ### **THIS ONE.** *"Enable your app to connect to the Slack MCP server…"* |

✅ **A correct end state is `Agent experience` OFF and `MCP Server` ON.** *Verified against a working app.*

⚠ **DO THIS BEFORE `claude mcp add` AND THE AUTHORIZE.** *Out of order, the OAuth completes and the connection still refuses — two surfaces disagreeing, one of them cheerful.*

## B3 · Register and authorize

**As PATH A steps A1–A2.** *Client ID is on Basic Information; it is not secret. The Client Secret is behind **Show** on the same page.*

⚠ **`--scope user`, never `--scope project`** — *`project` writes a `.mcp.json` into whatever repo you happen to be in, and this is not repo-specific.*

## B4 · Give the app a bot identity

**a.** *OAuth & Permissions → **Bot** Token Scopes → add `chat:write`.* (Creates the bot user. If refused, set a Display Name under **App Home** first.)

# ⚠⚠ **AND A MANIFEST MUST DECLARE THAT BOT USER ITSELF — THE PASTE SKIPS THE CLICK THAT CREATES IT**

### **Slack rejects any manifest carrying `oauth_config.scopes.bot` with no `features.bot_user`:** `OAuth requires bot_user`. *Both shipped manifests failed validation, so **PATH BUS step 1 could not be completed at all** — the bus-only path was the fix for a reported gap, and its very first action did not work.*

```json
  "features": { "bot_user": { "display_name": "Claude Code Bus", "always_online": false } },
```

★ **THE DEPENDENCY WAS ALREADY IN THIS FILE, ONE LINE ABOVE** — *"add `chat:write`. **Creates the bot user.**"* # **It sat in the CLICK path, which is the one that no longer needs it.** *The manifest route was added later and inherited the requirement without the sentence.*

⛔ **AND THE MANIFEST WAS REVIEWED, NEVER EXECUTED.** *Same class as a guard whose condition is read and whose output never prints:* # **A MANIFEST THAT HAS NEVER BEEN PASTED HAS NEVER BEEN VALIDATED.** ✔ *Enforced statically now — `slack-post.mjs --self-test` fails if any manifest beside it declares bot scopes without a `bot_user`.*

**b.** # ⛔ **DO NOT CLICK THE YELLOW BANNER.** ### **Scroll UP to *OAuth Tokens* and click "Reinstall to \<workspace\>" there.** → *trap 5 — this is the single most expensive trap in this file.*

# ⚠ **THE REINSTALL ROTATES THE USER TOKEN AND BREAKS THE WORKING CONNECTION** → *trap 3.* ### **Warn BEFORE the click, not after.**

★ **No listener on the callback port is needed.** *Slack's reinstall completes server-side without bouncing through the redirect URL. A session once stood one up as insurance; it was never hit.*

**c.** *OAuth & Permissions → **Bot User OAuth Token** (`xoxb-…`)* → user stashes it under **the name this repo declares in `token_env`**, or `SLACK_BOT_TOKEN` if it declares none (→ **§2**).

## B5 · Give the app an icon *(optional, but it is the app's face in every channel)*

```
python <plugin>/skills/slack-as-claude/make-app-icon.py --emoji "🤖" --bg "#2C2D30" --out app-icon.png
# needs Pillow:  python -m pip install Pillow
```

*Upload at* **Basic Information → Display Information → App icon** *→ **Save Changes**.*

★ **Set the icon HERE rather than per message.** *It needs no `chat:write.customize`, and it applies everywhere the app appears — including messages already sent.*

# ⚠⚠ SLACK DOES NOT HONOUR TRANSPARENCY ON APP ICONS. **IT COMPOSITES ONTO WHITE.**

### *A transparent PNG arrives as a glyph on a white square whatever the viewer's theme.* **Paint the background explicitly.** *Full-bleed square — Slack applies its own rounded mask, so baking in a corner radius double-rounds it.*

⚠ **And colour emoji fonts need `embedded_color=True` on an RGBA target.** *Segoe UI Emoji, Apple Color Emoji and Noto Color Emoji are bitmap fonts; without it the glyph renders as a **flat black silhouette** — which looks like a real icon until you see it beside one.* **They also only carry strikes at particular sizes; the bundled script draws at 109pt and downsamples.**

---

# 2. THE TOKEN, AND THE ENV VAR TRAP

# ⛔⛔⛔ FIRST: **ONE REPO, ONE WORKSPACE — AND POSTING TO THE WRONG ONE RETURNS `ok: true`**

### **A `xoxb-` token is scoped per app PER WORKSPACE.** *If the machine's token is for workspace **A** while this repo means to talk to **B**, the post **SUCCEEDS**. No error, no warning — it lands where nobody is reading, and the success line is byte-identical to a correct one.*

★ **Reported from the field after exactly that, and found only by calling `auth.test` by hand.** # **It is this project's worst class — a WRONG value rendering exactly like a right one — pointed at the DESTINATION**, *and it becomes reachable the moment a second workspace exists, because that is when the wrong token stops being impossible and starts being selectable.*

## ✔ **DECLARE THE BINDING IN THE REPO. IT IS COMMITTABLE AND CARRIES NO SECRET:**

```json
// <repo>/.claude/slack-workspace.json
{ "team_id": "T0123456789", "team": "Acme", "token_env": "SLACK_BOT_TOKEN_ACME" }
```

| `team_id` | ★ **strongest** — exact, and survives a workspace rename. Read it from `auth.test`. |
| :-- | --- |
| `team` / `url` | accepted for convenience, matched case-insensitively |
| `token_env` | **optional** — which env var holds THIS repo's credential. ⚠ **The variable NAME is not a secret; the token is.** |

# ★★★ THE SPLIT IS THE WHOLE DESIGN — **DESTINATION IS REPO-SCOPED, CREDENTIAL IS MACHINE-SCOPED**

| **which workspace** | belongs to the **repo** · committable · **read at CALL time** |
| :-- | --- |
| **the credential** | belongs to the **machine** · never committed · `process.env` → registry |

### ⚠ **Routing the DESTINATION through the environment would inherit the launch-time trap below** — *a running process cannot see a variable set after it started.* **A file in the checkout is read when the command runs, so that trap does not apply to it at all.** ★ *And two IDE windows on one checkout cannot disagree about a file at the git root, which is exactly the invariance a one-repo-one-workspace rule needs.*

## **RESOLUTION ORDER, both halves:**

```
destination : <git root>/.claude/slack-workspace.json    (absent -> unenforced, as before)
credential  : process.env[token_env || SLACK_BOT_TOKEN]  -> HKCU\Environment, same name
verify      : auth.test on every send; a mismatch REFUSES with exit 2, naming BOTH
```

⛔ **A mismatch refuses rather than warns**, *because a warning on a path that still succeeds is precisely how the original misdelivery happened.* ✔ **`--dry-run` and `slack-watch.mjs --doctor` both name the destination**, so *"where is this going"* is answerable without sending. ✔ **No declaration = today's behaviour exactly** — a single-workspace machine needs no configuration.

---

| **Windows** | `setx <TOKEN_VAR> "xoxb-..."` — *where `<TOKEN_VAR>` is the repo's `token_env`, else `SLACK_BOT_TOKEN`* |
| :-- | --- |
| **macOS / Linux** | `export <TOKEN_VAR>="xoxb-..."` *in the shell profile* |

# ⚠⚠ SETTING IT DOES NOT MAKE IT VISIBLE TO THE RUNNING SESSION.

### **A process inherits its PARENT's environment block at launch. Claude Code's was captured before you ran that command — so a lookup returns EMPTY while the variable plainly exists.** *This is not Windows-specific; the same is true of `export` on macOS and Linux.*

★ **`slack-post.mjs` works around it on Windows** *by reading `HKCU\Environment` directly when `process.env` comes up empty* — **so a freshly-`setx`'d token works without restarting.** ⚠ *There is no equivalent trick on macOS/Linux: an `export` needs a restarted session, or pass the value inline.*

⚠ **The three IDENTITY variables in §3 get no such workaround** — *they are read from `process.env` normally, so they DO need a restart.*

---

# 3. POSTING

## First, the bot must be in the channel

```
/invite @<the app's display name>
```

⚠ **Per channel, permanently. Without it every post fails `not_in_channel`** — *valid token, correct scope, still refused.* **This is the single most common failure for a repo that is otherwise fully set up.**

## Then

```bash
node "<this skill's dir>/slack-post.mjs" --channel <channel id> --text "..."
```

★ **Node 18+, no dependencies** *(global `fetch`, `node:util` `parseArgs`)*. **Runs anywhere Claude Code does** — *which is the point: Claude Code is a Node program, so Node is present by construction. Python is not.*

**`--thread-ts <ts>`** replies in a thread — *get the `ts` from `mcp__slack__slack_read_channel`.* # ⚠ **QUOTE IT** *(→ §THREADING below)*
**`--dry-run`** prints the composed identity and sends nothing. **Use it before the first real post, and for every experiment.**

**Success:** `Posted to C01234ABCDE as the app [project: `myrepo`  session: `cea6f85a`  user: Your Name  machine: your-pc  os: windows] - ts 1788096941.956549`

★ **Full switch and override reference is in §PER-SESSION IDENTITY below.**

---

## ★ PER-SESSION IDENTITY — telling several Claude sessions apart

**Every message is labelled with where it came from**, so a channel several sessions post into stays legible. **The display name is left ALONE — Slack shows the app's own name and avatar — and ALL the detail goes in a context block on the message:**

```
Claude Code MCP                                          APP     <- the app's own name
project: your-repo   session: cea6f85a   user: Your Name
      machine: YOUR-MACHINE   os: windows                     <- context block, 5 elements
The actual message.
```

| Element | Detected from | Override |
| :-- | --- | --- |
| **project** | the **MAIN** worktree's basename, else cwd | `--project` |
| **worktree** | the linked worktree's basename — **absent when you are in the main one** | `--worktree` |
| **session** | `CLAUDE_SESSION_NAME`, else first 8 of `CLAUDE_CODE_SESSION_ID` | `--session` |
| **user** | Claude account `displayName` from `~/.claude.json`, else OS user | `--user` |
| **machine** | `CLAUDE_SLACK_MACHINE`, else hostname | `--machine` |
| **os** | `windows` · `macos` · `linux` | — |

**One element per facet, so SLACK does the spacing** — not a separator character you chose. *Labels are plain, identifiers are code-formatted.*

## ⚠ **IF YOUR REPO USES GIT WORKTREES, `project` IS THE REPO — NOT THE SLOT YOU ARE STANDING IN**

### **It used to be the slot, and that was a bug: a repo with a primary plus two fixed worktrees announced itself as `repo`, `repo-a` and `repo-b` from ONE codebase** — *to any peer filtering on `project:`, three unrelated projects.* # **`project:` is now the main worktree, resolved through `--git-common-dir`, so all three read as one repo.**

★ **The slot name is still useful — "which lane posted this" — so it did not get thrown away. It got its OWN facet.** *`worktree:` appears only when you are in a linked one, and readers parse context elements with a generic key regex, so nothing that predates it breaks.*

| standing in | `project:` | `worktree:` |
| :-- | :-: | :-: |
| the main worktree | `repo` | *(absent)* |
| a subdirectory of it | `repo` | *(absent)* |
| a linked worktree `repo-a` | `repo` | `repo-a` |

⛔ **AND IF YOU ARE EVER TEMPTED TO "JUST USE `--git-common-dir`": ON ITS OWN IT IS A SECOND BUG.** ### *It returns a path **relative to the cwd** in the main worktree — `.git` at the root, `../.git` one level down — so `dirname()` of it yields `..` and the project label becomes literally `..`.* **Resolve it against `--show-toplevel` first.** *Measured from a subdirectory of a real repo before the fix was written.*

⚠ **The user's EMAIL is opt-in** — `--user-email` or `CLAUDE_SLACK_USER_EMAIL=1` renders `Josh (josh@example.com)`. # **Do not make it the default.** ### *Every message is visible to the whole channel, and a skill installed by someone else must not stamp their address into their workspace because you did not think about it.*

## ★ SETTING THE OVERRIDES — per call, or once and for all

**Two mechanisms. Parameters win over environment variables, which win over detection.**

### Per call — a parameter, for this message only

```bash
node slack-post.mjs --channel C01234ABCDE --text "..." \
    --project "billing-api" \
    --session "nightly-reindex" \
    --user    "release-bot" \
    --machine "ci-runner-3" \
    --user-email
```

### Persistent — an environment variable, for every message from this machine

| Variable | Sets | Example |
| :-- | --- | --- |
| `CLAUDE_SESSION_NAME` | **session** — a human label instead of the raw id. ⛔ **ONE SESSION PER MACHINE ONLY → see the warning below** | `hart-audit` |
| `CLAUDE_SLACK_MACHINE` | **machine** — friendlier than a Windows default | `my-laptop` |
| `CLAUDE_SLACK_USER_EMAIL` | **user** — include the address (`1`/`true`/`yes`) | `1` |

*Windows* `setx NAME "value"` · *macOS/Linux* `export NAME="value"` *in the shell profile.*

# ⛔⛔ **`CLAUDE_SESSION_NAME` IS MACHINE-WIDE. IF YOU RUN CONCURRENT SESSIONS, PASS `--session <label>` INSTEAD.**

### **One variable, inherited at launch, so every session on the machine reads the SAME value and announces the SAME label.** ⚠ **Two sessions sharing a label collapse into ONE presence message and ONE roster row — neither individually addressable, neither `--ping`-able** *(measured; the full consequence list is in the bus skill).* # **The asymmetry is the point: `machine` is genuinely one value per machine, and `session` is many. An environment variable can express the first and structurally cannot express the second.**

# ⚠⚠ THESE THREE DO NOT AFFECT THE RUNNING SESSION.

### **They are read from `process.env`, which was inherited at launch — so setting one now changes nothing until the session restarts.** **Pass the equivalent flag instead for the current session.** *(`SLACK_BOT_TOKEN` is the exception: on Windows the script falls back to reading the registry, so that one takes effect immediately.)*

### Switches

| `--dry-run` | **Compose and print, send nothing.** *Use for every experiment — see the deletion limit below.* |
| :-- | --- |
| `--no-context` | Drop the context line; post a bare message under the app. |
| `--as-app` | Drop the whole identity apparatus. |
| `--username` · `--icon-emoji` | **Override the DISPLAY NAME and AVATAR.** ⚠ *The only options that need `chat:write.customize`.* |
| `--thread-ts` | Reply in a thread. ⚠ **Quote the value** *(→ §THREADING).* |

# ★★ WHY IT ALL LIVES IN THE CONTEXT BLOCK

### **MEASURED, not read off a doc — Slack documents neither.**

| **Display name** | # **CLIPS at ~50 visible characters.** *Window-width dependent, silent, mid-word.* ★ *An earlier design composed the identity INTO the name and put the session id last — Slack ate exactly the part that made it unique.* |
| :-- | --- |
| **Context block** | # **WRAPS. Does not clip.** ### *A 300-character ruler rendered all 300, flowing onto a second line.* **API cap is 3000 per text object, 10 elements per block — neither is reachable in practice.** ⚠ *Costs vertical space, so one line's worth (~260 chars at a typical width) is the real budget.* |

⚠ **Runs of whitespace COLLAPSE in a context block.** *Padding to align columns does not survive. Use separate elements.*

★ **Consequence: the context line is nearly free, and the DEFAULT PATH NEEDS NO SPECIAL SCOPE.** *Nothing is overridden, so plain `chat:write` is enough.* **Five elements used, five spare — add a git SHA, worktree or task label if useful.**

## ⚠ Two implementation traps, both SILENT

- # **KEEP `text` POPULATED ALONGSIDE `blocks`.** ### *It is what push notifications and unfurls read.* **Drop it and mobile alerts arrive silent and contentless** — *and nothing in the API response tells you.*
- # **CHECK YOUR SERIALISER'S DEPTH LIMIT.** ### *Blocks nest four levels.* **A serialiser that truncates deep structures will mangle them silently** — *PowerShell's `ConvertTo-Json` defaults to depth 2 and emits type names instead of objects, which is why this skill is Node now.* `JSON.stringify` *has no such limit.*

# ⚠⚠ §THREADING — QUOTE THE TIMESTAMP, ALWAYS

### **A Slack `ts` like `1788097923.905509` has 16 significant digits. Any shell or language that coerces it to a float rounds it to** `1788097923.90551`. ## **Slack does not recognise that ts, IGNORES the threading, posts to the CHANNEL instead, and returns `ok: true`.** # **NOTHING REPORTS A PROBLEM.**

★ *`slack-post.mjs` validates the format and refuses a mangled value, so this now fails loudly.* **Any other caller must quote it itself.**

## ⚠ THE SCOPE NOTE — ONLY FOR `--username` / `--icon-emoji`

### **The default path overrides NOTHING, so plain `chat:write` covers it.** *Only the display-name and avatar overrides need `chat:write.customize`* — **and adding that scope is a scope change → reinstall → trap 3 → BOTH tokens rotate.** *Do not add it unless someone actually wants a custom display name.*

# ⚠⚠ WITHOUT THE SCOPE SLACK **SILENTLY IGNORES** `username` AND `icon_emoji`

## **It returns `ok: true` and posts under the app's default name.** *No `missing_scope`, no warning, no clue in the response.* # **A SUCCESSFUL POST IS NOT EVIDENCE THE OVERRIDE APPLIED.**

### ★ **So verify the TOKEN, not the response.** *Any Web API call returns the granted scopes in a response header:*

```bash
curl -s -D - -o /dev/null -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" | grep -i '^x-oauth-scopes:'
```

```bash
node -e 'fetch("https://slack.com/api/auth.test",{method:"POST",headers:{Authorization:"Bearer "+process.env.SLACK_BOT_TOKEN}}).then(r=>console.log(r.headers.get("x-oauth-scopes")))'
```

# **If `chat:write.customize` is not in that list, the override cannot work — no matter what the post returned.**

# ★ THE SESSION ELEMENT — AND WHY IT IS NOT THE GIT BRANCH

## **A branch CANNOT identify a session.** *It is shared by every session working on it, so two sessions on `main` in the same repo would be indistinguishable.* **`CLAUDE_CODE_SESSION_ID` is the only per-session handle that exists** — stable for the session's life, unique across sessions.

⚠ # **Claude Code exposes NO session TITLE.** ### *Conversation summaries are written on compaction, not live — there is nothing to read at post time.* **Do not go looking for one; the id is what exists.** *Give a session a human label when it deserves one — that is the whole point of the override.* ⚠ **Via `--session` if the machine runs more than one at a time; `CLAUDE_SESSION_NAME` is machine-wide and would give them all the same name.**

★ *Three identities are easy to confuse, and they coincide on a personal machine:* **the CLAUDE ACCOUNT** *(`~/.claude.json` → `oauthAccount`, what the `user` element shows)*, **the OS LOGIN** *(`$env:USERNAME`, the fallback)*, and **the SLACK USER** *(the MCP user token's identity).* ⚠ **They diverge on a shared or remote box — say a build agent logged in as `svc-deploy` running under someone's personal Claude account.**

## ⛔ Two limits of the override, both real

- # **It is a DISPLAY override, not a separate account.** ### *Every message still comes from the same bot with the same `APP` badge; clicking through shows the one underlying app.* **Good for "which project is talking". Useless against anyone adversarial.** *True separation means one Slack app per identity — the whole of PATH B, per identity.*
- # ⚠ **A message posted with an overridden identity CANNOT be retracted with `chat.delete`.** ### **This bites for real: a throwaway test post cannot be cleaned up by the thing that made it — a human has to delete it by hand.** *Think before posting anything you may need to withdraw, and prefer `-DryRun` for experiments.*

⚠ ★ **AND THE MCP READ TOOLS DO NOT SHOW THE OVERRIDE.** ### `slack_read_channel` *reports the AUTHORING BOT for every such message — the custom name is invisible to it.* # **So you cannot verify the rendering by reading it back, and you cannot verify it from the post response either.** ## **Check the token's scopes, then ask a human to look at the channel.** *Those are the only two honest checks.*

## ★ Getting the channel id

# ⚠⚠ TWO ROUTES, AND THE DOCUMENTED ONE CAN BE UNAVAILABLE WHILE ITS PRECONDITION READS AS SATISFIED

| **1 · ASK THE HUMAN. FIVE SECONDS, NO TOOLING.** | ### **Right-click the channel → Copy link → the `C…` segment.** *Or channel name → About.* # **This works when nothing else does, and it was missing from this file entirely.** |
| :-- | --- |
| **2 · Through MCP** | `mcp__slack__slack_search_channels` — *fine when the tools are actually exposed.* |

## ⛔ **`claude mcp list` REPORTING `✔ Connected` DOES NOT MEAN THE `mcp__slack__*` TOOLS ARE EXPOSED TO YOUR SESSION.** ### *Observed: connected, and the tools absent.* ★ *A session that trusts the status line goes off to debug MCP instead of asking a question that takes five seconds.*

⚠ **AND THE BOT TOKEN GENUINELY CANNOT SUBSTITUTE** — *measured, not assumed:* `conversations.list` **→ `missing_scope`.** *The bot has no `channels:read`, deliberately, and adding it is a scope change → reinstall → trap 3. Ask the human instead.*

**Resolve it, then hard-code it.** ⚠ *The bot token cannot look it up — `search_channels` runs on the USER token and the bot has no `channels:read`.*

# ★★ THEN RECORD IT IN THE REPO'S `CLAUDE.md`.

### **This is the ONLY per-repo artefact this whole skill produces.** *One line — which channel this repo posts to, and its id — so the next session in that repo does not have to re-derive it.*

```
Slack: post progress to #build-notifications (C01234ABCDE) via the slack-as-claude skill.
```

---

# 4. THE FIVE TRAPS

# ⚠⚠⚠ 5 · THE YELLOW BANNER'S REINSTALL LINK DOES NOT APPLY SCOPES

### **Change a scope and Slack shows a banner: *"You've changed the permission scopes… Please reinstall your app."* # ITS LINK DOES NOT DO THE JOB.**

## **The one that works is "Reinstall to \<workspace\>" under *OAuth Tokens*, further up the same page.** ⚠ *Both are on `/oauth`. Both say reinstall. Only one applies the scopes.*

# ★ HOW IT PRESENTS — AND WHY IT COSTS HOURS

**Everything looks correct and nothing reports an error.** *The scope is listed under Bot Token Scopes, marked Required. The banner goes away. The app says installed.* # **AND THE TOKEN STILL CARRIES THE OLD SCOPES.**

### **This cost FOUR rounds of diagnosis on `chat:write.customize`** — *a session repeatedly proposed wrong explanations (wrong scope section, missed reinstall, missed Allow, stale token copy) while the user had correctly done every step, using the link that silently does nothing.*

## ⛔ **DIAGNOSE BY TOKEN, NEVER BY APPEARANCE:**

```bash
curl -s -D - -o /dev/null -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" | grep -i '^x-oauth-scopes:'
```

★ *The correct link opens a consent page; it needs an explicit **Allow**.* **The token STRING does not change — Slack updates the grant in place — so "the token looks the same" is EXPECTED and proves nothing.** *Only the scope list moves.*

---

## The other four

| # ⚠ **1 · "Create and Install" CANNOT SUCCEED FROM A BROWSER — *IF THE MANIFEST CARRIES `redirect_urls`*** | ### **The condition is the whole trap, and an earlier draft stated the outcome unconditionally.** *The failure is an OAuth redirect to `localhost:<port>`, **which only Claude Code can answer** — so it can only happen when there is a redirect to follow.* <br><br> ⛔ **`slack-app-manifest.json` HAS `redirect_urls` → it fails, and "Installation was not completed" is expected and meaningless.** <br> ✔ **`slack-app-manifest_bus-only.json` HAS NONE → no localhost hop, and it SUCCEEDS cleanly on the first click.** *Measured on a real PATH BUS run.* <br><br> # ⚠⚠ **THE DANGER IS THE DIRECTION IT IS STATED IN.** ### **Told in advance that a failure message is meaningless, a reader dismisses a GENUINE install failure.** *Unconditional here is not merely imprecise — it disarms the reader against the real thing.* <br><br> **When it does fail: IT STILL CREATES THE APP ON EVERY ATTEMPT.** ★ *One app per click.* **Click once, then check `api.slack.com/apps` — it is there.** ## **For PATH B the real install happens at `/mcp`, not here.** |
| :-- | --- |
| # ⚠ **2 · THE SIDEBAR'S "MCP Servers" PAGE IS THE WRONG DIRECTION** | ### It reads *"Connect MCP servers **to your app**"* and warns it will add an **`mcp:connect` bot scope**. **That is Slackbot consuming EXTERNAL MCP servers — the opposite of what you want.** ★ *A session once checked that page, correctly concluded it was the wrong direction, and wrongly concluded no toggle was needed at all.* # **The switch is under Agents. The server's own error names the right URL — read it.** |
| # ⚠ **3 · A REINSTALL ROTATES THE USER TOKEN** | ### Any scope change → reinstall → **the connection dies with `! Needs authentication`.** *Thirty seconds to fix, but say it BEFORE the click.* |
| # ⚠⚠ **4 · `/mcp` LIES ABOUT "connected"** | ### It has shown **`✔ connected · 19 tools`** while `claude mcp list` said **`! Needs authentication`** and a live call failed **`token expired`**. ## **The display reflects the TRANSPORT connecting and a CACHED tool list — not a valid token.** # **NEVER TRUST IT. VERIFY WITH A LIVE CALL.** |

---

# 5. THE 19 MCP TOOLS

**Search** — `search_public` · `search_public_and_private` · `search_channels` · `search_users` · `search_emojis`
**Read** — `read_channel` · `read_thread` · `read_file` · `read_user_profile` · `list_channel_members` · `get_reactions`
**Write** — `send_message` · `send_message_draft` · `schedule_message` · `add_reaction` · `create_conversation`
**Canvas** — `create_canvas` · `read_canvas` · `update_canvas`

# ⚠ **A TOOL IN THAT LIST IS NOT PROOF IT WILL WORK.**

### **The server advertises its full tool set regardless of what the token can do; the scope check happens at CALL time.** *With the B1 manifest, `create_conversation` and the canvas WRITE tools fail — `channels:write` and `canvases:write` are not granted. Widening means a manifest edit and a re-auth (→ trap 3).*

⚠ # **`send_message` EXISTS AND WORKS — AND POSTS AS THE HUMAN.** ### *That is the whole reason `slack-post.mjs` exists. Reach for the script whenever the message is from the agent; reach for `send_message` only when the human is genuinely the author.*

★ *`schedule_message` is present but absent from Slack's published tool list — do not assume the docs enumerate the server exhaustively.*

---

# 6. ⚠ CLOUD SESSIONS — UNVERIFIED, AND PARTLY KNOWN-BROKEN

# **NOBODY HAS RUN THIS IN A CLOUD SESSION. Do not tell a user it works there.**

### *Everything below is reasoning from what the script depends on — NOT from a run.* **If it matters, write the portable version and TEST it; do not extrapolate from the Windows path.**

## What is genuinely portable

**The posting mechanism is just an HTTPS POST to `chat.postMessage` with a bearer token.** *Nothing about the payload, the context-block design or the element structure is machine-bound.* **`project` resolves from the cloned repo; `session` from `CLAUDE_CODE_SESSION_ID`; `user` from `~/.claude.json` in an authenticated session.**

★ **The poster is Node with no dependencies, so the LANGUAGE is no longer a blocker.** *It was PowerShell; a Linux sandbox has no `pwsh`. Node is present wherever Claude Code runs.*

## ⛔ What is still expected to break

| # **THE TOKEN HAS TO GET THERE** | ### *`SLACK_BOT_TOKEN` is set on one specific workstation.* **A cloud environment needs it injected through ITS OWN secret mechanism.** ⛔ *Never by copying it into a repo, a script, or a prompt.* ⚠ *The Windows registry fallback is irrelevant there — it will be a plain env var or nothing.* |
| :-- | --- |
| # **THE MCP SERVER IS NOT THERE** | ### *`slack` is registered in one machine's `~/.claude.json` at `--scope user`.* **A cloud session starts with its own config and has NO Slack tools** — reads need the whole registration and OAuth round trip again. ★ *Posting needs only the bot token; READING is the expensive half.* |
| # **`~/.claude.json` MAY DIFFER** | ### *The `user` element reads `oauthAccount` from it.* **If the shape differs or the file is absent the script falls back to the OS user** — *which in a container is often `root`.* |

## ⚠ What silently changes MEANING rather than breaking

- # **`machine` becomes an ephemeral container hostname** — *a different random string every run.* **Noise, not signal.** *Override it to the routine or job name.*
- # **`os` becomes `linux` for every message** — *a constant, carrying no information.*

★ **So even once a portable poster exists, the ELEMENT SET wants rethinking for cloud.** *`machine` and `os` earn their place on a workstation and stop earning it in a sandbox.*

---

# 7. WHEN IT BREAKS

| **`! Needs authentication` / `token expired`** | `/mcp` → `slack` → authenticate. **If offered "Clear authentication" first, take it** — forces a fresh round trip instead of trusting the cached credential. |
| :-- | --- |
| **Tools missing but server connected** | **Session started before the server was authorized. Restart.** *Reconnecting does not retro-fit tools into a running registry.* |
| # **`Unknown skill` after installing the plugin** | ### **SAME MECHANISM, ONE LAYER UP — and the reload commands do not reliably cover it.** *Try `/reload-plugins`, then **RESTART THE SESSION**.* ⚠ **Observed once (VSCode extension, Windows 11): neither `/reload-plugins` nor `/reload-skills` registered the skills; only reopening the session did.** ⛔ **And `claude plugin list` said `✔ enabled` throughout** — *right version on disk, `enabledPlugins` set, frontmatter valid.* # **`✔ enabled` IS ABOUT THE INSTALL, NOT ABOUT WHETHER A RUNNING SESSION CAN SEE IT.** ★ *One environment, one occurrence, never deliberately reproduced — and it is not clear whether it is specific to the VSCode extension. Stated at that strength rather than promoted to a rule.* |
| **`App is not enabled for Slack MCP server access`** | **The Agents toggle is off** → B2. |
| **`not_in_channel`** | **Bot not invited to that channel** → §3. |
| **`invalid_token_type`** | **A bot token was pointed at `mcp.slack.com`** — *the proven-impossible path. Use the script, not MCP.* |
| **`$env:SLACK_BOT_TOKEN` is empty** | **Expected** → §2, read it from the registry. |
| **`invalid_auth` / `token_revoked` on a post** | **The bot token is stale** — *someone reinstalled the app.* Re-copy it and re-stash it **under the same name it already had** — `slack-watch.mjs --doctor` and the scripts name that variable in their error, so read it there rather than assuming. |

---

# ⚠ SEARCHING THE WEB FOR "SLACK MCP SERVER" WILL MISLEAD YOU

# **The top results describe COMMUNITY servers** — `korotovsky/slack-mcp-server`, `piekstra`, `bitovi`, the archived `@modelcontextprotocol/server-slack`.

### **Those DO take bot tokens, and say so confidently.** ## **They are different software with a different auth model and the same name. `mcp.slack.com` is not those projects.** *Check which server a page is about before believing anything it says about tokens.*
