---
name: slack-as-claude
description: Use when a repo needs Claude to post into Slack — whether connecting to a Slack app that already exists or building one from scratch. Covers the read-as-human / post-as-app identity split, the one-time machine-wide setup that every later repo inherits for free, and the five traps that reliably cost time.
---

# Slack from a Claude session

**Goal: a Claude session in any repo can post into Slack under the app's own identity, and read the workspace as the human.**

# ★★ START HERE — MOST OF THE TIME THERE IS NOTHING TO SET UP.

### **The Slack MCP server is registered at `--scope user`, and the bot token lives in a user environment variable. Both are MACHINE-WIDE.** *Once one repo has done the setup, every other repo on that machine already has it.*

```
claude mcp list
```

| # **You only want the SESSION BUS** *(post · watch · claim between concurrent sessions)* | # **→ PATH BUS.** ### **Two bot scopes and an invite. Skip everything else in this file.** ★ *The scripts call four bot-token endpoints and nothing else — measured, not assumed.* |
| :-- | --- |
| # **Already working here, adding a SECOND WORKSPACE** | # **→ PATH SECOND.** *A second app, a distinct token variable, and a binding file. `claude mcp add` and the OAuth authorize are NOT repeated.* |
| **`slack … ✓ Connected`** | # **→ Nothing to install. Go to §3 POSTING.** *You need one thing only: the channel id.* ⚠ **`✓ Connected` does NOT guarantee the `mcp__slack__*` tools are exposed to your session** — *if they are absent, §3's human route gets you the id anyway.* |
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
| # **POST as the app** | The bundled `slack-post.mjs` → `chat.postMessage` on the **bot** token. **Lands with an `APP` badge, as a different user id.** |

- **Route reads through the bot instead** and the agent goes blind to most of the workspace — *a bot only sees channels it was invited to.*
- **Route posts through the user token instead** and every agent message is **indistinguishable from the human** in Slack's audit trail. *No badge, no "via app" — months later they cannot tell what they wrote from what the agent wrote.*

---

# ⛔ THE CREDENTIAL RULE — APPLIES TO BOTH PATHS

# **A `xoxb-` token, a client secret and an OAuth code are credentials. NONE may enter the transcript.**

*The pattern that works:* **the user runs the command carrying the secret, in their own terminal, and reports only that it is done.** *You read the result from `claude mcp list`, which shows errors but never values.*

⚠ **You cannot run `claude mcp add --client-secret` for them.** *The agent shell is non-interactive with stdin on the null device; the prompt reads EOF and fails.*

---

# ★★★★★★ PATH BUS — **YOU ONLY WANT THE SESSION BUS. YOU NEED NONE OF THE MCP SETUP.**

### **MEASURED, not assumed. The complete set of Slack endpoints all three scripts call:**

```
auth.test  ·  chat.postMessage  ·  conversations.history  ·  conversations.replies
```

## **All four are BOT-token endpoints. There is no `mcp__slack__` call and no user token anywhere in the scripts.** ⛔ **So routing a bus-only reader through PATH B — twenty user scopes, the Agents/MCP toggle, `claude mcp add`, the OAuth authorize, a matching callback port, and B4b's reinstall — imposes THIS FILE'S OWN WORST TRAP on a use case that needs two bot scopes.**

| **1** | `api.slack.com/apps` → **Create New App** → **From a manifest** → paste **`slack-app-manifest_bus-only.json`** (beside this file) → pick the workspace |
| :-: | --- |
| **2** | **Install to Workspace**, and approve |
| **3** | *OAuth & Permissions* → **Bot User OAuth Token** (`xoxb-…`) → stash it under **this repo's `token_env`**, or `SLACK_BOT_TOKEN` if it declares none |
| **4** | In Slack: **`/invite @<the app>`** in the channel. *A bot that is not a member cannot post, and the error does not say so plainly.* |
| **5** | Get the channel id — **ask the human** *(§3, and it is five seconds)* |

### **That is the whole path.** *No MCP server, no user token, no OAuth flow, no callback port, no reinstall, no trap 5.* ✔ **`--doctor`, `--presence`, `--ping`, claiming and posting all work on this alone.**

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

## ✔ **THE END STATE: no user-scope Slack MCP at all. Each repo declares its own at `--scope project`,** *which writes `.mcp.json` into that checkout — no secret in it, just a URL.*

⚠⚠ **DO NOT MIGRATE BEFORE YOU NEED IT.** ### *With one workspace there is nothing to leak, and the migration touches a WORKING OAuth to solve a problem you do not yet have.*

# ⚠ **AND MEASURE THIS BEFORE ASSUMING IT IS FREE:** ### **the cached credential is keyed `<server-name>|<hash>`.** *Whether moving scope preserves that key — and therefore the authorisation — depends on what the hash covers.* **If it survives, the move costs nothing. If it does not, you re-run the OAuth flow on a connection that currently works.** ⛔ *Reason from the key format if you like, but CHECK IT: read `~/.claude/.credentials.json` before and after, on a machine you can afford to re-authorise.*

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

# ★★★ THE MANIFEST IS A FILE IN THIS SKILL, NOT A BLOCK IN THIS DOCUMENT.

### **`slack-app-manifest.json`, beside this file.** *It was inline here and is not any more, because a manifest that exists twice drifts — and this project has spent two days on exactly that failure.* # **Copy the file. Do not retype from prose.**

⚠ **IT NOW CARRIES BOT SCOPES AS WELL AS USER SCOPES, AND THAT IS THE FIX FOR A TRAP THE ORIGINAL CAUSED.** ### *The first version had 21 user scopes and **zero** bot scopes — so posting as the app did not work, the bot scopes were added by hand afterwards, and that edit is a scope change, which forces a reinstall and **rotates both tokens** (→ trap 3).* # **A NEW app created from this manifest gets them at install time, in one pass, with no reinstall.**

| `user` | 21 read-leaning scopes plus `chat:write` — what the **MCP server** uses, acting as you |
| :-- | --- |
| `bot` | `chat:write` · `channels:history` · `groups:history` — what **`slack-post` / `slack-watch` / `slack-claim`** use |

### **The bot set is derived from the four API methods the scripts actually call** — `chat.postMessage` · `chat.update` · `chat.delete` · `conversations.history` · `conversations.replies` — *not from guessing generously.* ⛔ `chat:write.customize` *is deliberately absent: it is only needed for a custom display name or avatar, and adding it is a scope change for a cosmetic feature.* *`groups:history` is there so a **private** bus channel works; drop it if yours is public.*

- **`http://localhost:8765/callback` is plain HTTP and Slack accepts it.** *The HTTPS requirement has a localhost carve-out. Do not reach for ngrok or a tunnel.*
- **The port is arbitrary but must match `--callback-port` forever after.** *Otherwise Claude Code picks a random port and the redirect will not match.*
- **USER scopes deliberately** — read-leaning plus `chat:write`. *Adding `channels:write` / `files:write` / `canvases:write` lets the agent restructure the workspace. Start without; add on request.*
- **Only directory-published or internal apps may use MCP.** *An unlisted app is refused.*

# ⚠⚠ CLICK "Create and Install" **ONCE** AND EXPECT IT TO FAIL → *trap 1*

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

**b.** # ⛔ **DO NOT CLICK THE YELLOW BANNER.** ### **Scroll UP to *OAuth Tokens* and click "Reinstall to \<workspace\>" there.** → *trap 5 — this is the single most expensive trap in this file.*

# ⚠ **THE REINSTALL ROTATES THE USER TOKEN AND BREAKS THE WORKING CONNECTION** → *trap 3.* ### **Warn BEFORE the click, not after.**

★ **No listener on the callback port is needed.** *Slack's reinstall completes server-side without bouncing through the redirect URL. A session once stood one up as insurance; it was never hit.*

**c.** *OAuth & Permissions → **Bot User OAuth Token** (`xoxb-…`)* → user stashes it under **the name this repo declares in `token_env`**, or `SLACK_BOT_TOKEN` if it declares none (→ **§2**).

## B5 · Give the app an icon *(optional, but it is the app's face in every channel)*

```
python make-app-icon.py --emoji "🤖" --bg "#2C2D30" --out app-icon.png
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

⛔ **A mismatch refuses rather than warns**, *because a warning on a path that still succeeds is precisely how the original misdelivery happened.* ✔ **`--dry-run` and `--doctor` both name the destination**, so *"where is this going"* is answerable without sending. ✔ **No declaration = today's behaviour exactly** — a single-workspace machine needs no configuration.

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
| **project** | git repo root's basename, else cwd | `--project` |
| **session** | `CLAUDE_SESSION_NAME`, else first 8 of `CLAUDE_CODE_SESSION_ID` | `--session` |
| **user** | Claude account `displayName` from `~/.claude.json`, else OS user | `--user` |
| **machine** | `CLAUDE_SLACK_MACHINE`, else hostname | `--machine` |
| **os** | `windows` · `macos` · `linux` | — |

**One element per facet, so SLACK does the spacing** — not a separator character you chose. *Labels are plain, identifiers are code-formatted.*

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
| `CLAUDE_SESSION_NAME` | **session** — a human label instead of the raw id | `hart-audit` |
| `CLAUDE_SLACK_MACHINE` | **machine** — friendlier than a Windows default | `my-laptop` |
| `CLAUDE_SLACK_USER_EMAIL` | **user** — include the address (`1`/`true`/`yes`) | `1` |

*Windows* `setx NAME "value"` · *macOS/Linux* `export NAME="value"` *in the shell profile.*

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

⚠ # **Claude Code exposes NO session TITLE.** ### *Conversation summaries are written on compaction, not live — there is nothing to read at post time.* **Do not go looking for one; the id is what exists.** *Set `CLAUDE_SESSION_NAME` when a session deserves a human label — that is the whole point of the override.*

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
| **`App is not enabled for Slack MCP server access`** | **The Agents toggle is off** → B2. |
| **`not_in_channel`** | **Bot not invited to that channel** → §3. |
| **`invalid_token_type`** | **A bot token was pointed at `mcp.slack.com`** — *the proven-impossible path. Use the script, not MCP.* |
| **`$env:SLACK_BOT_TOKEN` is empty** | **Expected** → §2, read it from the registry. |
| **`invalid_auth` / `token_revoked` on a post** | **The bot token is stale** — *someone reinstalled the app.* Re-copy it and re-stash it **under the same name it already had** — `--doctor` and the scripts name that variable in their error, so read it there rather than assuming. |

---

# ⚠ SEARCHING THE WEB FOR "SLACK MCP SERVER" WILL MISLEAD YOU

# **The top results describe COMMUNITY servers** — `korotovsky/slack-mcp-server`, `piekstra`, `bitovi`, the archived `@modelcontextprotocol/server-slack`.

### **Those DO take bot tokens, and say so confidently.** ## **They are different software with a different auth model and the same name. `mcp.slack.com` is not those projects.** *Check which server a page is about before believing anything it says about tokens.*
