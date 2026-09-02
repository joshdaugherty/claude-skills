# CLAUDE.md — `claude-skills`

A Claude Code **plugin marketplace** (`.claude-plugin/marketplace.json`) carrying one plugin, **`slack-as-claude`** — a Slack channel used as a bus so concurrent Claude sessions on different machines can talk.

---

## ⛔⛔ BEFORE YOU SHIP — THE STANDING ORDER

# **Run an adversarial review of the diff, per `.claude/rules/adversarial-review.md`.**

### ✔ **That file is ALREADY IN YOUR CONTEXT.** *It carries no `paths:` frontmatter, so it loads at launch with the same priority as this file.* # **This heading is emphasis, not the loading mechanism — so do not restate the rule's content here.** *Everything it already says (the three defect tiers, the `--dry-run` probe, `+dev`, the review lenses) is deliberately absent below.*

# ⚠⚠ **AND IF NEITHER FILE IS IN CONTEXT, THE SESSION WAS STARTED OUTSIDE THIS REPO.**
### **`CLAUDE.md` and `.claude/rules/` resolve from the session's working directory and its ancestors — nothing else.** *A session driven from a window open to a different repository loads neither, and **that is the case the rule was written in and then not followed in.*** **The user-scope `~/.claude/CLAUDE.md` covers it.** ★ *Verify with `/context` → **Memory files**.*

---

## The gate — after the review's fixes, not before

```
node plugins/slack-as-claude/skills/slack-as-claude/slack-post.mjs      --self-test
node plugins/slack-as-claude/skills/slack-session-bus/slack-watch.mjs   --self-test
node plugins/slack-as-claude/skills/slack-session-bus/slack-claim.mjs   --self-test
node --check <every .mjs touched>
awk '$0 ~ /^>?[[:space:]]*\|/ { if ($0 !~ /\|[[:space:]]*$/) print "BAD ROW " NR }' <every SKILL.md touched>
```

---

## ⛔ Never print a credential

### **Two leaks in one day, both from an agent answering the innocent question *"is the token set?"*.** *A registry dump, an `echo $VAR`, a `reg query` on `HKCU\Environment` — all leak.* # **Compare, and report a verdict. Never echo a value.**

---

## The loops

| **Issues** | **branch → commit → PR to `main` carrying `Closes #N` → merge.** # ⚠⚠ **READ THE ISSUE'S COMMENTS, NOT ONLY ITS BODY.** *#70 exists because a comment posted **four minutes** after the body corrected it and was never read; the body was implemented faithfully and the ticket was still wrong.* |
| :-- | --- |
| **Releases** | **Bump `version` in `plugins/slack-as-claude/.claude-plugin/plugin.json` or installs will not see the change.** *Then tag, announce **from the released copy**, install, move the registrations.* # ⚠ **Ask Joshua before cutting a release.** ★ *A change entirely outside `plugins/` ships nothing and needs no bump.* |
| **Registrations** | ### **`claude plugin marketplace update` refreshes the CATALOG. `claude plugin install` populates a CACHE DIRECTORY.** # **Only `claude plugin update` moves a REGISTRATION** *(measured: 39 installs, 0 registrations moved)*, **and it defaults to `--scope user`** — *a registration is pinned per scope in `~/.claude/plugins/installed_plugins.json`.* |
