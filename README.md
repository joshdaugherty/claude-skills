# claude-skills

A [Claude Code](https://claude.com/claude-code) plugin marketplace. Each plugin bundles one or
more skills; Claude Code handles installing and updating them.

## Install

```
/plugin marketplace add joshdaugherty/claude-skills
/plugin install slack-as-claude@claude-skills
```

⚠ **`/plugin` is not available in every editor.** `/plugin isn't available in this environment` was
observed in **Cursor** at two extension versions (2.1.246 and 2.1.252), so within that range it is
not version-dependent; stock VS Code was fine the same day. No data on Windsurf, VSCodium or
Positron — don't generalise "forks" from one fork. That message means *use the CLI*, not *something
is broken*.

⚠ **You can't tell which editor you're in from the session's own environment banner.** A session
running in **Cursor** reports *"You are running inside a VSCode native extension environment"* — that
is the extension's generic self-description, not a fork discriminator — and `TERM_PROGRAM` is unset.
An agent asked "which editor is this?" will answer *VS Code*, confidently and wrongly. The extension
**path** discriminates: `~/.cursor/extensions/anthropic.claude-code-…` vs `~/.vscode/extensions/…`.

**If the slash command is unavailable, use the CLI from the repo root:**

```
claude plugin install slack-as-claude@claude-skills
```

⛔ **And if that reports `claude: command not found` — the IDE extension does not install a CLI.**
A machine can have a current Claude Code extension and no `claude` binary anywhere. That is an
ordinary state for anyone who installed the editor extension and nothing else, not a broken setup.
Install one:

```
brew install claude-code                       # macOS
npm install -g @anthropic-ai/claude-code       # any platform with npm
```

★ **This section carries install-time answers deliberately.** The skill's own documentation loads by
*invoking* the skill, which requires the install to have worked — so anything that can fail *during*
installation has to be answerable from here, or the reader cannot reach the answer.

<details>
<summary>macOS: where to put the bot token, since that also happens before the skill is readable</summary>

**Find out which shell is actually running — don't guess, and don't pick from a list:**

```
basename "$(ps -p $$ -o comm=)"      # zsh -> ~/.zshrc ; bash -> ~/.bash_profile
```

⚠ **The `basename` is not optional.** Measured on macOS, `ps -p $$ -o comm=` prints `/bin/bash` — an
absolute path — so `case "$(ps …)" in zsh) … bash) … esac` matches **neither arm** and falls silently
through.

⛔ **Don't fall back to `$SHELL`.** It's the login shell from your passwd entry, *not the shell that
is running*. On a machine whose login shell is `zsh` while the harness spawns `bash`, `$SHELL` names
the file that will **not** be sourced — which is the exact bug this check exists to prevent.

*A free tell in any terminal paste: `zsh` prompts with `%`, `bash` with `$`.*

⚠ **From Git Bash on Windows this fails — `ps: unknown option -- o`.** That's MSYS's `ps` lacking
`-o`, **not** the probe being wrong; don't "fix" a correct command on the strength of it.

⚠ `~/.bashrc` is the wrong file on macOS even when you *are* on bash — an interactive login shell
reads `~/.bash_profile`, and `~/.bashrc` is often absent entirely. Writing to both is harmless.

### ⛔ And do not "restart the session" — on macOS that is not a weaker fix, it is not a fix

Measured on macOS 26.6.2 in Cursor: the harness shell is **non-login** (`shopt -q login_shell` → 1)
and **non-interactive** (`$-` → `hBc`), so it sources no profile at all. And restarting doesn't reach
it either:

```
~/.bash_profile  modified  Sep 2 08:52:50
44201 <- 40125             Sep 2 09:26    bash
40125 <- 1722              Sep 2 08:54    claude            <- the SESSION restarted here
 1722 <- 1262              Aug 26 08:42   extension-host    <- inherits from this, 7 days old
 1262 <- 1                 Aug 26 08:42   Cursor  (from the GUI, env from launchd)
```

The session restarted *after* the export and still couldn't see it, because it inherits from the
extension host — which predates the export by a week. **The restart never crossed the boundary where
the environment is established.** A GUI-launched app never reads a shell profile, at launch or
afterwards, and nothing beneath it can.

⚠ An earlier version of this block called the 08:54 process *"the extension host"*. It was the
**session**. The probe was `ps -p $PPID`, which returns **exactly one level** — one level of a
four-level chain, reported as the whole chain, and it reads identically to a correct result. **Walk
the chain to PID 1, or you're naming whichever process you looked at first.**

✔ **The one remedy measured working end to end:** `bash -lc 'node …/slack-post.mjs …'` — token and
`CLAUDE_SLACK_MACHINE` both resolved, live post succeeded, nothing restarted. ⚠ A profile that guards
on `[[ $- == *i* ]]` would be skipped by a login-but-non-interactive shell and defeat this; the
machine measured had no such guard.

✔ **`launchctl setenv` propagates — measured.** It sets the `launchd` environment, is correctly
invisible to an already-running app, and an app launched *afterwards* does inherit it. ⛔ It still
**does not survive a reboot** (persisting needs a LaunchAgent), so it's a within-session mechanism,
not a durable alternative to a profile export.

⛔ **How that was measured matters more than the result: the first run was a false negative that
looked exactly like a finding.** Probed against `Calculator`, the variable came back `ABSENT` — from
a 61-character dump containing **zero** variables, because `ps -E` can't read the environment of a
SIP-protected Apple binary. `USER` and `HOME` were "absent" too. Without a positive control that
would have been reported as *"launchctl does not propagate"* — the exact opposite of the truth.

✔ So **any `ps -E` probe on macOS needs a known-present variable checked alongside the one under
test, and a third-party binary as the target.** ⚠ Second trap in the same test: `open` also
propagates the *calling shell's* environment, so an `open`-launched process isn't a clean model of a
Dock-launched one — the result holds only because `launchctl setenv` provably doesn't touch the
calling shell.

★ **Bounded:** one macOS machine, one editor, one day. It establishes the mechanism; it does not
establish that every macOS harness is non-login — an editor launched *from a terminal* would inherit
that terminal's environment and behave completely differently.

★ **Windows hides this entirely**, which is why it went unnoticed for so long: there the token falls
back to `HKCU\Environment` when the environment is empty, so it is found no matter what shell
spawned the process. The platform with the weaker environment story is the one with less tooling.

*Reported from a real macOS onboarding; this project has no macOS machine, so it is recorded at the
strength it was received rather than measured here.*

</details>

Update later with:

```
/plugin marketplace update claude-skills
```

This repo is **public**, so `marketplace add` clones without credentials.

⚠ **The CLI splits the update into two commands, and the first reports success on its own:**

```
claude plugin marketplace update claude-skills      # moves the CLONE
claude plugin install slack-as-claude@claude-skills # installs it
```

Running only the first prints `✔ Successfully updated marketplace` while the installed version
does not move. **After any update, check the installed version rather than the tick** —
`~/.claude/plugins/cache/claude-skills/slack-as-claude/`. The `/plugin marketplace update`
slash command appears to do both.

⚠ **A freshly installed plugin's skills are not active in a session that was already running.** Try
`/reload-plugins` first — it is cheap. **If the skill still does not resolve, restart the session.**
A session builds its skill registry at startup, and reloading does not always retro-fit into it: on
one observed environment (VSCode extension, Windows 11) neither `/reload-plugins` nor
`/reload-skills` worked and only reopening the session did.

**`claude plugin list` reporting `✔ enabled` is not evidence the skills are registered.** It is
true of the *installation* — right version on disk, `enabledPlugins` set — and says nothing about
whether a running session can see it. When every surface reports success and the invocation still
returns `Unknown skill`, the session is the thing that has not caught up. This applies to any
plugin from this marketplace, not just `slack-as-claude`.

<details>
<summary>Manual install, if you'd rather not use the plugin system</summary>

Claude Code also discovers skills directly in `~/.claude/skills/` (user-level, every repo) or
`<repo>/.claude/skills/` (project-level). Copy a skill directory in, or link it:

**Windows — directory junction, no administrator needed:**

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\slack-as-claude" -Target "D:\GitHub Repos\claude-skills\plugins\slack-as-claude\skills\slack-as-claude"
```

*(A symlink works too but needs an elevated shell, or Developer Mode enabled. A junction has the
same effect here and needs neither. To remove one, use `cmd /c rmdir <path>` — `rm -rf` can follow
the link and delete the target.)*

**macOS / Linux:**

```bash
ln -s ~/src/claude-skills/plugins/slack-as-claude/skills/slack-as-claude ~/.claude/skills/slack-as-claude
```

Don't do both — a linked skill and an installed plugin would give you two skills with the same
name.

</details>

## Plugins

### `slack-as-claude`

Lets a Claude session post into Slack under the app's own identity instead of as you.

Two skills ship in this plugin, and both are slash-invocable:

```
/slack-as-claude:slack-as-claude     # setup: connect, build from scratch, or join a repo
                                     # someone else already configured
/slack-as-claude:slack-session-bus   # the bus protocol between concurrent sessions
```

**Reach for the first one.** It is the intended entry point — it works out which state you are
already in rather than making you pick a path, and it holds the traps and the per-OS steps. Invoke
the second when you have a working bus and want the addressing, claiming and liveness protocol
that runs over it.

Slack's official MCP server (`mcp.slack.com`) is **user-token-only** — bot tokens are refused with
`invalid_token_type` — so everything sent through the MCP tools is attributed to the signed-in
human with no "via app" marker. The skill sets up a deliberate split: **read** through the MCP
tools as yourself, **post** through a bundled script on the app's bot token, which lands with an
`APP` badge.

Covers connecting to an existing Slack app, building one from scratch, joining a repo that already
uses it, and the traps that reliably waste time — that reinstalling from the yellow banner silently
does not do the job; that Slack's "Create and Install" button cannot succeed from a browser **when
the manifest declares `redirect_urls`** (it ends in an OAuth redirect to `localhost`, which only
Claude Code can answer — the bus-only manifest declares none and installs first click); and that
`/mcp` reports a server's state from a cache: it will say `connected` when the token has expired,
and has also reported a server unauthorized while its token was demonstrably live.

**If all you want is the bus between concurrent sessions, none of the MCP setup applies.** That
route — PATH BUS in the skill — is three bot scopes and a channel invite: no MCP server, no user
token, no OAuth flow, and it sidesteps the most expensive trap in the file. The skill's scripts
call four bot-token endpoints and nothing else.

What is machine-wide and what is not:

- **Machine-wide** — the `slack` MCP registration (`--scope user`) and the OAuth authorize behind
  it. Done once.
- **Per repo** — the *destination*. `<git root>/.claude/slack-workspace.json` names the workspace
  a repo may post to, is committed, and carries no secret; posting to the wrong workspace
  otherwise returns `ok: true` and lands where nobody is reading. That file also names the
  *credential* via `token_env`, so a second repo pointing at a second workspace has neither the
  binding nor the variable until someone sets them.

So a second repo on the same machine is not automatically ready, and the skill detects which of
those states you are in before asking you anything.

The plugin also bundles **`slack-session-bus`**: using a Slack channel as a message bus between
concurrent Claude sessions, with a claim protocol that makes races deterministic by sorting on
Slack's server-assigned timestamps — turning claiming from a locking problem into a sorting one.

It ships three scripts: `slack-post.mjs` (post as the app), `slack-watch.mjs` (deliver, presence,
`--ping`, `--doctor`, `--raw`, `--audit`) and `slack-claim.mjs` (claim, re-read, and answer in the
exit code — `0` you hold it, `1` stand down).

**Exercised, not finished.** Two concurrent sessions ran it against a live workspace for a day:
messages exchanged, a contested claim resolved with no human relay, addressing and liveness built
and working. Twelve defects were found in the process, essentially all by *using* it rather than
reading it — and every one was a surface confidently reporting something the underlying state did
not support. What is still open is stated in the skill's own header rather than hidden: no run at
scale, and the claim protocol has never been followed by an agent that was not first told to
follow it.

## Layout

```
.claude-plugin/marketplace.json     lists the plugins
plugins/<name>/
  .claude-plugin/plugin.json        name, description, version
  skills/<skill>/SKILL.md           the skill, plus any bundled resources
```

Bump a plugin's `version` in its `plugin.json` on every release, or installs won't see the update.

## Rules

- [**adversarially verify before shipping**](.claude/rules/adversarial-review.md) — a green `--self-test` earns the
  build, not the ship. Also names the three defect tiers here and which one no agent can reach.

## Conventions

- **Skills stay generic.** No workspace ids, account names, machine paths, or repo-specific values
  in a `SKILL.md` — those belong in project memory or the consuming repo's `CLAUDE.md`.
- **Bundled resources sit beside the `SKILL.md`** and are referenced relative to it.
- **Credentials never appear in a skill**, and skills should say so where it matters.
