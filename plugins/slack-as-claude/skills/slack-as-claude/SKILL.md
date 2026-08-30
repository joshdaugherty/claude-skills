---
name: slack-as-claude
description: Use when a repo needs Claude to post into Slack — whether connecting to a Slack app that already exists or building one from scratch. Covers the read-as-human / post-as-app identity split, the one-time machine-wide setup that every later repo inherits for free, and the four traps that reliably cost time.
---

# Slack from a Claude session

**Goal: a Claude session in any repo can post into Slack under the app's own identity, and read the workspace as the human.**

# ★★ START HERE — MOST OF THE TIME THERE IS NOTHING TO SET UP.

### **The Slack MCP server is registered at `--scope user`, and the bot token lives in a user environment variable. Both are MACHINE-WIDE.** *Once one repo has done the setup, every other repo on that machine already has it.*

```
claude mcp list
```

| **`slack … ✓ Connected`** | # **→ Nothing to install. Go to §3 POSTING.** *You need one thing only: the channel id.* |
| :-- | --- |
| **Listed but `! Needs authentication`** | → **§6 WHEN IT BREAKS.** *Thirty seconds, not a rebuild.* |
| **Not listed, but the workspace already has the Slack app** | → **PATH A.** *New machine, existing app. Two commands.* |
| **Not listed, no app anywhere** | → **PATH B.** *First time in this workspace. ~20 minutes, mostly clicking.* |

# ⛔ **DO NOT run PATH B because a new repo "doesn't have Slack yet."** *A repo never has Slack. The machine does.*

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
| # **POST as the app** | The bundled `slack-post.ps1` → `chat.postMessage` on the **bot** token. **Lands with an `APP` badge, as a different user id.** |

- **Route reads through the bot instead** and the agent goes blind to most of the workspace — *a bot only sees channels it was invited to.*
- **Route posts through the user token instead** and every agent message is **indistinguishable from the human** in Slack's audit trail. *No badge, no "via app" — months later they cannot tell what they wrote from what the agent wrote.*

---

# ⛔ THE CREDENTIAL RULE — APPLIES TO BOTH PATHS

# **A `xoxb-` token, a client secret and an OAuth code are credentials. NONE may enter the transcript.**

*The pattern that works:* **the user runs the command carrying the secret, in their own terminal, and reports only that it is done.** *You read the result from `claude mcp list`, which shows errors but never values.*

⚠ **You cannot run `claude mcp add --client-secret` for them.** *The agent shell is non-interactive with stdin on the null device; the prompt reads EOF and fails.*

---

# PATH A — CONNECT (existing app, new machine)

**You need from the user: the app's Client ID, its Client Secret, and the Bot User OAuth Token.** *All three are on `api.slack.com/apps/<app id>` — Client ID and Secret under **Basic Information**, the bot token under **OAuth & Permissions**.*

**A1.** The user runs, in their own terminal:

```
claude mcp add --transport http slack https://mcp.slack.com/mcp --scope user --client-id <id> --client-secret --callback-port 8765
```

*The `--callback-port` must match a redirect URL already registered on the app. If the app was built with this skill it is `http://localhost:8765/callback`.*

**A2.** `/mcp` → `slack` → authenticate. # **Then RESTART the session** *(→ trap 4).*

**A3.** The user stashes the bot token: `setx SLACK_BOT_TOKEN "<the xoxb- token>"` → **§3**.

# ✔ **Done. No Slack UI needed at all.**

---

# PATH B — SET UP FROM SCRATCH

## B1 · Create the app from a manifest

`api.slack.com/apps` → **Create an App** → **From a manifest** → pick the workspace.

```json
{
  "display_information": {
    "name": "Claude Code MCP",
    "description": "Lets Claude Code connect to the Slack MCP server"
  },
  "oauth_config": {
    "redirect_urls": ["http://localhost:8765/callback"],
    "scopes": {
      "user": [
        "channels:history", "channels:read",
        "groups:history", "groups:read",
        "im:history", "im:read",
        "mpim:history", "mpim:read",
        "search:read.public", "search:read.private", "search:read.files",
        "search:read.im", "search:read.mpim", "search:read.users",
        "users:read", "users:read.email",
        "files:read", "emoji:read",
        "reactions:read", "reactions:write",
        "chat:write"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "is_hosted": false,
    "token_rotation_enabled": false
  }
}
```

- **`http://localhost:8765/callback` is plain HTTP and Slack accepts it.** *The HTTPS requirement has a localhost carve-out. Do not reach for ngrok or a tunnel.*
- **The port is arbitrary but must match `--callback-port` forever after.** *Otherwise Claude Code picks a random port and the redirect will not match.*
- **USER scopes deliberately** — read-leaning plus `chat:write`. *Adding `channels:write` / `files:write` / `canvases:write` lets the agent restructure the workspace. Start without; add on request.*
- **Only directory-published or internal apps may use MCP.** *An unlisted app is refused.*

# ⚠⚠ CLICK "Create and Install" **ONCE** AND EXPECT IT TO FAIL → *trap 1*

## B2 · Turn on the toggle that actually matters

# **Agents → "Slack Model Context Protocol (MCP) Server" → On.**

*Until this is on, every connection returns* `App is not enabled for Slack MCP server access`. # ⛔ **NOT the sidebar's "MCP Servers" page** → *trap 2*

## B3 · Register and authorize

**As PATH A steps A1–A2.** *Client ID is on Basic Information; it is not secret. The Client Secret is behind **Show** on the same page.*

⚠ **`--scope user`, never `--scope project`** — *`project` writes a `.mcp.json` into whatever repo you happen to be in, and this is not repo-specific.*

## B4 · Give the app a bot identity

**a.** *OAuth & Permissions → **Bot** Token Scopes → add `chat:write`.* (Creates the bot user. If refused, set a Display Name under **App Home** first.)

**b.** Slack shows a reinstall banner. **Click it.**

# ⚠ **THE REINSTALL ROTATES THE USER TOKEN AND BREAKS THE WORKING CONNECTION** → *trap 3.* ### **Warn BEFORE the click, not after.**

★ **No listener on the callback port is needed.** *Slack's reinstall completes server-side without bouncing through the redirect URL. A session once stood one up as insurance; it was never hit.*

**c.** *OAuth & Permissions → **Bot User OAuth Token** (`xoxb-…`)* → user runs `setx SLACK_BOT_TOKEN "<token>"`.

---

# 2. THE ENV VAR TRAP — READ THE REGISTRY, NOT `$env:`

```powershell
[Environment]::GetEnvironmentVariable('SLACK_BOT_TOKEN', 'User')
```

### **`setx` writes to `HKCU\Environment`. A child process inherits its PARENT's environment block, and Claude Code's block was captured before `setx` ran — so `$env:SLACK_BOT_TOKEN` is EMPTY while the variable plainly exists.** *The bundled script already does this correctly.*

⚠ *macOS/Linux: exporting from a shell profile has the same trap for the same reason — a running process keeps its original block. Restart the session there.*

---

# 3. POSTING

## First, the bot must be in the channel

```
/invite @<the app's display name>
```

⚠ **Per channel, permanently. Without it every post fails `not_in_channel`** — *valid token, correct scope, still refused.* **This is the single most common failure for a repo that is otherwise fully set up.**

## Then

```powershell
& "<this skill's dir>\slack-post.ps1" -Channel <channel id> -Text "..."
```

**`-ThreadTs <ts>`** replies in a thread — *get the `ts` from `mcp__slack__slack_read_channel`.*

**Success:** `Posted to C01234ABCDE as bot B01234ABCDE - ts 1788055161.122969`

## ★ Getting the channel id

**Resolve it through MCP** (`mcp__slack__slack_search_channels`), **then hard-code it.** ⚠ *The bot token cannot look it up — `search_channels` runs on the USER token and the bot has no `channels:read`.*

# ★★ THEN RECORD IT IN THE REPO'S `CLAUDE.md`.

### **This is the ONLY per-repo artefact this whole skill produces.** *One line — which channel this repo posts to, and its id — so the next session in that repo does not have to re-derive it.*

```
Slack: post progress to #build-notifications (C01234ABCDE) via the slack-as-claude skill.
```

---

# 4. THE FOUR TRAPS

| # ⚠ **1 · "Create and Install" CAN NEVER SUCCEED FROM A BROWSER** | ### It ends in an OAuth redirect to `localhost:<port>`, **which only Claude Code can answer.** *"Installation was not completed" is expected and meaningless.* # **BUT IT CREATES THE APP ON EVERY ATTEMPT.** ★ *Clicking it repeatedly makes one app per click.* **Click once, then check `api.slack.com/apps` — it is there.** ## **The real install happens at `/mcp`, not here.** |
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

⚠ # **`send_message` EXISTS AND WORKS — AND POSTS AS THE HUMAN.** ### *That is the whole reason `slack-post.ps1` exists. Reach for the script whenever the message is from the agent; reach for `send_message` only when the human is genuinely the author.*

★ *`schedule_message` is present but absent from Slack's published tool list — do not assume the docs enumerate the server exhaustively.*

---

# 6. WHEN IT BREAKS

| **`! Needs authentication` / `token expired`** | `/mcp` → `slack` → authenticate. **If offered "Clear authentication" first, take it** — forces a fresh round trip instead of trusting the cached credential. |
| :-- | --- |
| **Tools missing but server connected** | **Session started before the server was authorized. Restart.** *Reconnecting does not retro-fit tools into a running registry.* |
| **`App is not enabled for Slack MCP server access`** | **The Agents toggle is off** → B2. |
| **`not_in_channel`** | **Bot not invited to that channel** → §3. |
| **`invalid_token_type`** | **A bot token was pointed at `mcp.slack.com`** — *the proven-impossible path. Use the script, not MCP.* |
| **`$env:SLACK_BOT_TOKEN` is empty** | **Expected** → §2, read it from the registry. |
| **`invalid_auth` / `token_revoked` on a post** | **The bot token is stale** — *someone reinstalled the app.* Re-copy it and re-run `setx`. |

---

# ⚠ SEARCHING THE WEB FOR "SLACK MCP SERVER" WILL MISLEAD YOU

# **The top results describe COMMUNITY servers** — `korotovsky/slack-mcp-server`, `piekstra`, `bitovi`, the archived `@modelcontextprotocol/server-slack`.

### **Those DO take bot tokens, and say so confidently.** ## **They are different software with a different auth model and the same name. `mcp.slack.com` is not those projects.** *Check which server a page is about before believing anything it says about tokens.*
