# claude-skills

A [Claude Code](https://claude.com/claude-code) plugin marketplace. Each plugin bundles one or
more skills; Claude Code handles installing and updating them.

## Install

```
/plugin marketplace add joshdaugherty/claude-skills
/plugin install slack-as-claude@claude-skills
```

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

## Conventions

- **Skills stay generic.** No workspace ids, account names, machine paths, or repo-specific values
  in a `SKILL.md` — those belong in project memory or the consuming repo's `CLAUDE.md`.
- **Bundled resources sit beside the `SKILL.md`** and are referenced relative to it.
- **Credentials never appear in a skill**, and skills should say so where it matters.
