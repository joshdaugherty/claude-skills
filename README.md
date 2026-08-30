# claude-skills

Portable [Claude Code](https://claude.com/claude-code) skills. One directory per skill, each
self-contained: a `SKILL.md` plus whatever it bundles.

## Install

Claude Code discovers skills in `~/.claude/skills/` (user-level, available in every repo) or
`<repo>/.claude/skills/` (project-level). Either copy a skill directory in, or symlink it so
updates here propagate.

**Windows (PowerShell, as administrator for symlinks):**

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills\slack-as-claude" -Target "D:\GitHub Repos\claude-skills\slack-as-claude"
```

**macOS / Linux:**

```bash
ln -s ~/src/claude-skills/slack-as-claude ~/.claude/skills/slack-as-claude
```

Copying works just as well — symlinking only matters if you want to edit in one place.

## Skills

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

## Conventions

- **Skills stay generic.** No workspace ids, account names, paths, or repo-specific values in a
  `SKILL.md` — those belong in project memory or the consuming repo's `CLAUDE.md`.
- **Bundled resources sit beside the `SKILL.md`** and are referenced relative to it.
- **Credentials never appear in a skill**, and skills should say so where it matters.
