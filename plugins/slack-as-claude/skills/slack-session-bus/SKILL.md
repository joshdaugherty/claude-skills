---
name: slack-session-bus
description: Use when two or more concurrent Claude sessions need to talk to each other, hand off work, or avoid doing the same task twice — using a Slack channel as the bus. Covers the wire format, addressing, the claim protocol that makes races deterministic, staleness, and what polling can and cannot do. DRAFT — the protocol is designed, not yet proven in use.
---

# Slack as a bus between concurrent Claude sessions

# ⚠ STATUS: DRAFT, BUT NO LONGER SPECULATIVE.

### **§1, §4 and §5 were exercised by two concurrent sessions against a live workspace, and they hold.** *Claiming resolved identically from both vantage points; delivery works once each session arms a watcher.*

# ⛔ STILL UNPROVEN: **§3 addressing** *(the `to:`/`type:` flags do not exist yet, so filtering does not actually work)*, **§6 staleness** *(no liveness signal at all)*, **and the claim protocol with an UNPROMPTED agent** — *the test session was told to follow it.*

**Prerequisite: the `slack-as-claude` skill, fully set up.** *This adds a protocol on top of its posting script and the MCP read tools; it adds no new Slack configuration.*

---

# 1. THE WIRE FORMAT — ✅ VERIFIED

**A message posted by `slack-post.mjs` arrives at a reader like this**, via `mcp__slack__slack_read_channel`:

```
=== Message from Claude Code MCP (U0BUG9NBJD6) at 2026-08-30 08:46:39 CDT ===
Message TS: 1788097599.459439
project: `daugherty-ydna`
session: `cea6f85a`
user: Josh
machine: DESKTOP-HBNGBFQ
os: windows
the actual message body
```

# ★★ THE CONTEXT BLOCK COMES THROUGH, FLATTENED TO `label: value` LINES.

### **This is the whole reason a bus is possible without inventing an envelope.** *The sender's identity arrives already structured.*

# ⚠⚠ BUT THE RAW WEB API AND THE MCP TOOLS GIVE DIFFERENT SHAPES

| `mcp__slack__read_*` | **Flattens the context block INTO the text**, as `label: value` lines above the body. *The flattening is done by the MCP server.* |
| :-- | --- |
| `conversations.history` | **Does NOT.** *`text` is the body alone; the context block is in `blocks`.* ⚠ *Parsing `text` for a header here finds NOTHING.* |

# ★ PARSE THE CONTEXT BLOCK **ELEMENTS**, NOT FLATTENED TEXT.

### **`slack-watch.mjs` does this, and it is the correct read path for a second reason: an element parse CANNOT be fooled by prose in the message body that happens to look like a header.** ★ *A first version read `text` and dutifully picked `to:` out of an English sentence.*

⚠ **Message TS is server-assigned and is the ordering primitive everything below depends on.** *Read §4 before designing around anything else.*

| # ⚠⚠ **`&`, `<` AND `>` ARRIVE HTML-ESCAPED** | ### **As `&amp;` `&lt;` `&gt;`. Stored escaped by SLACK — confirmed on BOTH read paths, so no reader introduces it.** # **UNESCAPE ON PARSE.** ## *This is the worst of the three, because a bus between two coding sessions carries **CODE**: `a && b` comes back as `a &amp;&amp; b`, and pasting that into a shell or a `.js` file is **SILENT BREAKAGE**, not a syntax error anyone notices.* ⚠ *Decode `&amp;` LAST or `&amp;lt;` decodes twice.* |
| :-- | --- |
| ⚠ **Backticks survive** | *Values arrive as* `` `cea6f85a` `` *— strip them.* |
| ⚠ **URLs are angle-wrapped** | *`<https://...>` or `<url\|label>` — Slack's own mangling, unwrap on parse.* |
| ⚠ **Every message is from the same bot user** | ### **`U0BUG9NBJD6` for ALL sessions.** *The Slack author tells you NOTHING about which session sent it.* # **`session:` is the only sender identity. Trust nothing else.** |

---

# 2. WHAT THIS IS AND IS NOT

| ✔ **Good for** | Handoff between long-lived sessions · a shared work queue · "I have taken this, do not duplicate" · progress a human can watch live · **coordination ACROSS MACHINES** |
| :-- | --- |
| ⛔ **Bad for** | Anything needing sub-second latency · strong mutual exclusion · secrets · high message volume · **anything where a lost message is unacceptable** |

## ⚠ Compare honestly with the file-mailbox pattern before choosing

**A repo with two worktrees can already pass notes through committed files** *(e.g. `MAIL_TO_MAIN.md`)*, delivered deterministically on merge. **That is better than this bus whenever both sessions share one repo on one machine:** *no polling, no races, and the conversation is versioned with the work it concerns.*

# ★ THE BUS EARNS ITS PLACE ON TWO AXES ONLY: **ACROSS MACHINES**, AND **VISIBLE TO A HUMAN IN REAL TIME.**

---

# 3. ADDRESSING — DESIGN

**Two fields on top of what `slack-post.mjs` already emits.** *Implemented as extra context elements so they land in the same parseable header — see §7.*

```
to: r-branch          <- omit for broadcast
type: request         <- request | reply | claim | done | fail | status
session: cea6f85a     <- already emitted; the sender
```

### **A session should set `CLAUDE_SESSION_NAME` to a stable lane name** *(`main`, `r-branch`, `indexer`)*. **A raw session id changes every restart, which makes it useless as an address.**

⚠ **`to:` is a CONVENTION, not a delivery mechanism.** *Every session sees every message in the channel. Filtering is the reader's job, and a reader that ignores `to:` will happily act on someone else's work.*

---

# 4. CLAIMING — THE ONE PART THAT IS ACTUALLY SOUND

## ★★★ Slack assigns `ts` server-side, which gives a TOTAL ORDER every reader agrees on.

# **That turns claiming from a locking problem into a sorting problem. No lock is needed and none is possible.**

**The protocol:**

1. **Work is announced** as a channel message. *Its `ts` is the task id.*
2. **A session claims it** by posting a THREADED reply — `--thread-ts "<task ts>"` — with `type: claim`.
3. **The claimant re-reads the thread** with `slack_read_thread`.
4. # **The claim with the LOWEST `ts` wins. Every reader computes the same winner.**
5. **Losers stand down.** *Winner proceeds, and posts `type: done` (or `fail`) into the same thread when finished.*

### ⚠ **STEP 3 IS NOT OPTIONAL AND IS THE STEP THAT WILL BE SKIPPED.** *Posting a claim is not winning a claim.* # **A session that acts without re-reading has not implemented this protocol — it has implemented a race with extra steps.**

## ✅ VERIFIED: the primitive works

**Measured, not assumed** — *a parent message plus a threaded reply, read back with `slack_read_thread`:*

```
=== THREAD PARENT MESSAGE ===
Message TS: 1788097923.905509
session: `cea6f85a`
BUS TEST: parent task message.

=== THREAD REPLIES (1 total) ===
Message TS: 1788097975.534649
session: `claimant-a`
BUS TEST: threaded reply, ts passed as a QUOTED string.
```

**Threading holds, context blocks flatten in thread reads exactly as in channel reads, distinct `session:` labels survive, and each reply carries its own ordering `ts`.** *That is everything §4 needs.*

# ⚠⚠⚠ QUOTE THE TIMESTAMP. ALWAYS. THIS FAILURE IS COMPLETELY SILENT.

### **A Slack `ts` has 16 significant digits. Any shell or language that coerces the bare token to a FLOAT rounds `1788097923.905509` to `1788097923.90551`.** ## **Slack does not recognise that ts, IGNORES the threading, posts to the CHANNEL instead — and returns `ok: true`.** ★ *Observed in PowerShell; the same hazard exists in any caller that parses numerics eagerly.*

| ✔ | `--thread-ts "1788097923.905509"` | *17 chars, intact* |
| :-: | --- | --- |
| ⛔ | `--thread-ts 1788097923.905509` | *16 chars, silently wrong* |

★ *`slack-post.mjs` now validates the format and refuses a mangled ts, so this fails loudly.* **But any OTHER caller — curl, a script, a different language — has to quote it itself.** ⚠ *This bit during the very test that verified the protocol; the reply simply appeared in the channel and the thread read said `No thread messsages`.*

## Why threaded replies rather than reactions

★ *Reactions look like the obvious claim mechanism.* **They are worse in two ways:**

- # **A reaction carries NO timestamp.** ### *`reactions.get` returns who, never when.* **So a claim cannot expire, and a session that claims and dies holds the task forever.**
- **Reactions do not carry a payload** — *no session name, no reason, no detail.*

⚠ **Use reactions as a HUMAN-VISIBLE SUMMARY on top** *(👀 claimed, ✅ done)* — **never as the mechanism.**

---

# 5. ⚠⚠⚠ THE DEFINING CONSTRAINT: NOTHING IS DELIVERED

# **A SESSION IS NOT LISTENING. THIS IS A BULLETIN BOARD, NOT A BUS.**

### **A Claude session acts when prompted and then STOPS. Between turns it polls nothing, receives nothing, and cannot be woken.** *A message exists only for a session that happens to look.*

## ★ OBSERVED, first time of asking

**A task was announced and addressed to a live second session. It did nothing — because it had already finished its turn.** *It was never going to see it. The message sat unread until a human told that session to go and look.*

# ⛔ SO: "INTER-SESSION COMMUNICATION" WITHOUT A POLLER IS A HUMAN CARRYING NOTES.

### **Everything else in this file — addressing, claiming, staleness — assumes someone is reading. `slack-watch` (§7) is not one to-do among five. It is the thing that decides whether any of this works at all.**

⚠ **Design for "read the backlog on start", never for "I will be told."** *A message sent to a stopped session is not queued, not retried, and not delivered.*

---

# 5b. THE RACES — WHAT ACTUALLY GOES WRONG

| # **Double claim** | ### ✅ **RESOLVED, AND OBSERVED WORKING.** *Two sessions claimed one task; the second re-read, computed the same winner from the `ts` values, and stood down citing both.* **Independent agreement from two vantage points — the thing that would have sunk §4.** ⚠ **Only if BOTH re-read.** *And note the second session was TOLD to follow the protocol; an unprompted agent skipping step 3 is still untested.* |
| :-- | --- |
| # **Equal timestamps** | ### *Slack `ts` values carry microseconds and a per-channel counter, so ties are vanishingly unlikely — but a protocol that only ALMOST always agrees is a protocol that fails rarely and confusingly.* **Tiebreak on `session:` lexically. Deterministic, and costs one line.** |
| # ⚠⚠ **The dead claimant** | ### **A session claims, then its process ends.** *The task is claimed and will never be done.* # **NOTHING IN SLACK DETECTS THIS.** → *see §6* |
| # **Lost wakeup** | ### **PROMOTED TO §5 — it is the defining constraint, not one hazard among several.** |
| # **Duplicate work from re-reads** | ### *A session restarting re-reads the channel and sees its OWN earlier request as new.* **Ignore messages whose `session:` is your own** — *and note that a raw session id CHANGES on restart, so a stable `CLAUDE_SESSION_NAME` is what makes self-recognition possible at all.* |
| # **Edited messages** | ### *Slack keeps the original `ts` when a message is edited.* **Content can change under a reader that cached it. Re-read before acting on anything old.** |

---

# 6. STALENESS — UNSOLVED, AND THE WEAKEST POINT

# **A claim has a `ts`, so its AGE is computable. Whether the claimant is ALIVE is not.**

**The best available approximation:**

- **Treat a `claim` older than N minutes with no `done` or `fail` in its thread as STALE**, and allow re-claiming.
- **A long task must post periodic `type: status` into its thread** — *that is the heartbeat, and the only evidence of life the bus can carry.*
- ⚠ **N is a guess about how long work takes. Too short and live work gets stolen; too long and dead work blocks the queue.** *There is no correct value; pick one per channel and write it down.*

### ⛔ **Do not present this as reliable.** *It is a timeout with no liveness signal underneath. If double-execution would be destructive — a deploy, a migration, a payment — **THIS BUS IS THE WRONG TOOL.** Use something with real leases.*

---

# 7. STATE OF THE BUILD

- [x] # **`slack-watch.mjs`** — ✅ **BUILT AND PROVEN.** *A `Monitor` poll loop emitting one event per new message.* **Two sessions exchanged messages with NO human relay.** ★ *It needs `channels:history` on the BOT token — that is all; `groups:`/`im:`/`mpim:history` are NOT required for a public channel, so the bot still cannot read DMs or private channels.* ⚠ *An earlier draft of this file claimed the bot token could not do this and the user token was needed via MCP. **That was wrong and is struck.***
- [x] **A parser** — *lives in `slack-watch.mjs`; reads the CONTEXT BLOCK ELEMENTS, → §1.*
- [x] **A worked two-session test** — *§4 and §5 are no longer pure design.*
- [ ] **`--to` and `--type` parameters** on `slack-post.mjs`, emitting routing as context elements. ⚠ **Until then addressing is prose in the body, which the parser CANNOT read** — *so `to:` filtering does not actually work yet.*
- [ ] **A claim helper** doing post → re-read → decide, so the step that gets skipped is the step that is automated
- [ ] **A liveness signal**, → §6. *Still the weakest part.*

## ⚠ WHAT THE TWO-SESSION TEST CHANGED

| ✅ **§4 claiming** | **Two sessions claimed one task; the loser re-read, computed the same winner from `ts`, and stood down citing both values.** *Independent agreement — the thing that could have sunk it.* ⚠ *It was TOLD to follow the protocol; an unprompted agent is still untested.* |
| :-- | --- |
| ✅ **§5 delivery** | **Broken, by `slack-watch`** — *but only for a session that personally arms one.* |
| # ⚠⚠ **NEW: the bus is PER-SESSION OPT-IN** | ### **There is no "the channel is watched" — only "I am watching."** **A session that has not armed a watcher is UNREACHABLE, and nothing tells the sender.** *Messages look delivered.* ⚠ *Watchers are also time-bounded; coordination outlives them.* |
| # ⚠⚠ **NEW: BACKLOG REPLAY HANDS YOU CLOSED WORK** | ### **Observed live.** *A watcher armed with no cursor replayed the whole channel, including a task already claimed, resolved and closed twenty minutes earlier.* # **IT ARRIVED LOOKING EXACTLY LIKE NEW WORK.** ★ *Fixed in the DEFAULT rather than documented as a footgun: the first poll now primes the cursor silently and emits nothing; history is opt-in via `--replay`.* ## **What saved the session that hit it was re-reading the thread instead of trusting the watcher — §4 protecting against an unreliable delivery layer, which is exactly what it is for.** |

## ⚠ Open questions, genuinely unresolved

- **What is the polling interval?** *Every poll is a tool call and a wakeup. 30s is responsive and expensive; 5min is cheap and sluggish.*
- **One channel or one per project?** *One is simpler; several keep `to:` filtering honest and reduce noise.*
- **How does a session know it is done listening?** *A bus with no shutdown signal leaves monitors running until the session dies.*
- ~~**Does `slack_read_thread` flatten context blocks the same way?**~~ ### ✅ **MEASURED — yes, identically.** *See §4.*
- **What happens with two claims posted within the same second?** *The `ts` ordering should still separate them, but that is inference from the format, not a measurement.*
- **Does an edited claim keep its original `ts`?** *Slack keeps `ts` on edit for channel messages; assumed to hold in threads. Unverified, and §5 leans on it.*
