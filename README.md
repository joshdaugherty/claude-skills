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

Because this repo is **private**, the machine adding it needs git credentials that can read it —
an authenticated `gh`, or a credential helper holding a PAT with `repo` scope. On a machine where
that isn't set up, the `marketplace add` will fail to clone.

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

Slack's official MCP server (`mcp.slack.com`) is **user-token-only** — bot tokens are refused with
`invalid_token_type` — so everything sent through the MCP tools is attributed to the signed-in
human with no "via app" marker. The skill sets up a deliberate split: **read** through the MCP
tools as yourself, **post** through a bundled script on the app's bot token, which lands with an
`APP` badge.

Covers connecting to an existing Slack app, building one from scratch, and the four traps that
reliably waste time — including that Slack's "Create and Install" button can never succeed from a
browser, and that `/mcp` will report a server as `connected` when its token has expired.

Setup is machine-wide (`--scope user` plus a user environment variable), so **the first repo to
run it is the only one that has to** — every later repo inherits the connection.

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
