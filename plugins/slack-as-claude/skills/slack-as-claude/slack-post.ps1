<#
.SYNOPSIS
    Posts a Slack message as the app, labelled with the OS, machine, repo and session
    it came from.

.DESCRIPTION
    Slack's MCP server (mcp.slack.com) is user-token-only, so anything sent through the
    mcp__slack__* tools is attributed to the signed-in human with no "via app" marker.
    This script uses the app's BOT token against the plain Web API instead, so the
    message lands under the app with an APP badge.

    On top of that it sets a per-message display identity, so several Claude sessions
    posting into one channel are told apart at a glance:

        icon   <- the OS      :desktop_computer: / :apple: / :penguin:
        name   <- Claude - <user>@<machine> - <project> - <session>

    All of it is detected automatically and every part can be overridden.

    This needs the chat:write.customize bot scope. Without it Slack returns
    missing_scope; pass -AsApp to post under the app's plain identity instead.

    NOTE: a message posted with an overridden identity cannot be retracted with
    chat.delete. That is a Slack constraint, not a limitation of this script.

    The token is read from the SLACK_BOT_TOKEN *user* environment variable via the
    registry rather than $env:, because setx writes to HKCU\Environment while a running
    process keeps the environment block it inherited at launch. It is never printed.
    See SKILL.md beside this file for setup and traps.

.PARAMETER Channel
    Channel ID (e.g. C01234ABCDE). Resolve names with mcp__slack__slack_search_channels;
    the bot token cannot look them up itself. The bot must have been invited to the
    channel or the post fails with not_in_channel.

.PARAMETER Text
    The message body.

.PARAMETER ThreadTs
    Optional ts of a parent message, to reply in a thread.

.PARAMETER Project
    Repo/project label. Default: the git repository root's name, else the current
    directory's name.

.PARAMETER User
    Who is behind the session. Default: the Claude account's display name, read from the
    oauthAccount block of ~/.claude.json, falling back to the OS user.

    Note this is the CLAUDE account, not the OS login and not the Slack user - three
    identities that usually coincide on a personal machine and diverge on a shared or
    remote one.

.PARAMETER UserEmail
    Include the account's email address alongside the name: "Display Name (email)".
    Opt-in, because every message is visible to the whole channel and the default should
    not disclose an address in someone else's workspace. Can also be turned on for good
    with CLAUDE_SLACK_USER_EMAIL=1.

.PARAMETER Machine
    Machine label. Default: $env:CLAUDE_SLACK_MACHINE, else the computer name.
    Set CLAUDE_SLACK_MACHINE to something friendlier than a Windows default like
    DESKTOP-HBNGBFQ.

.PARAMETER Session
    Session label. Default: $env:CLAUDE_SESSION_NAME, else the first 8 characters of
    $env:CLAUDE_CODE_SESSION_ID.

    Claude Code does not expose a session *title* - it writes conversation summaries
    only on compaction, so there is nothing to read at post time. The session id is the
    only per-session handle that exists; set CLAUDE_SESSION_NAME for a human label.

    Deliberately NOT the git branch: a branch is shared by every session working on it,
    so it cannot distinguish one session from another.

.PARAMETER Username
    Overrides the whole composed display name.

.PARAMETER IconEmoji
    Overrides the OS-derived icon. Colon form, e.g. ":robot_face:".

.PARAMETER AsApp
    Skip the identity override and post under the app's own name and icon. Use if
    chat:write.customize has not been granted.

.EXAMPLE
    .\slack-post.ps1 -Channel C01234ABCDE -Text "Test suite green, 412 passed."

.EXAMPLE
    .\slack-post.ps1 -Channel C01234ABCDE -Text "Reindex done." -Session "hart-audit"

.EXAMPLE
    .\slack-post.ps1 -Channel C01234ABCDE -Text "Deployed." -AsApp
#>
param(
    [Parameter(Mandatory = $true)][string]$Channel,
    [Parameter(Mandatory = $true)][string]$Text,
    [string]$ThreadTs,
    [string]$Project,
    [string]$User,
    [string]$Machine,
    [string]$Session,
    [string]$Username,
    [string]$IconEmoji,
    [switch]$UserEmail,
    [switch]$NoContext,
    [switch]$AsApp,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$token = [Environment]::GetEnvironmentVariable('SLACK_BOT_TOKEN', 'User')
if (-not $token) {
    Write-Error 'SLACK_BOT_TOKEN is not set at User scope. Set it with: setx SLACK_BOT_TOKEN "xoxb-..."'
    exit 1
}

# --- identity ---------------------------------------------------------------

function Get-ProjectLabel {
    try {
        $root = git rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -eq 0 -and $root) { return (Split-Path -Leaf $root) }
    }
    catch { }
    return (Split-Path -Leaf (Get-Location).Path)
}

function Get-SessionLabel {
    # A human label if one was set, otherwise the session's own id. Not the git
    # branch: a branch is shared by every session on it, so it cannot identify one.
    if ($env:CLAUDE_SESSION_NAME) { return $env:CLAUDE_SESSION_NAME }
    return Get-SessionId
}

function Get-ClaudeUser {
    param([bool]$IncludeEmail)

    # The Claude account behind the session, read from the oauthAccount block of
    # ~/.claude.json. Falls back to the OS user.
    #
    # The email address is OPT-IN. Every message this script sends is visible to
    # everyone in the channel, so the default must not stamp an address into a
    # shared workspace that whoever installed this never thought about.
    #
    # Parsed defensively: that file has been seen with keys differing only by case,
    # which ConvertFrom-Json rejects without -AsHashtable - and -AsHashtable does not
    # exist on Windows PowerShell 5.1. So try the structured read, then a regex, then
    # give up gracefully. A label is never worth failing a post over.
    $osUser = if ($env:USERNAME) { $env:USERNAME } else { $env:USER }
    $path = Join-Path $HOME '.claude.json'
    if (-not (Test-Path $path)) { return $osUser }

    $name = $null
    $email = $null
    try {
        $raw = Get-Content $path -Raw -ErrorAction Stop
        try {
            $acct = ($raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop)['oauthAccount']
            $name = $acct['displayName']
            $email = $acct['emailAddress']
        }
        catch {
            if ($raw -match '"displayName"\s*:\s*"([^"]*)"') { $name = $Matches[1] }
            if ($raw -match '"emailAddress"\s*:\s*"([^"]*)"') { $email = $Matches[1] }
        }
    }
    catch { return $osUser }

    if (-not $IncludeEmail) {
        if ($name) { return $name }
        # No display name and email withheld - the local part is the most we should
        # show by default. Better an ambiguous label than an unintended disclosure.
        if ($email) { return ($email -split '@')[0] }
        return $osUser
    }

    if ($name -and $email) { return "$name ($email)" }
    if ($name) { return $name }
    if ($email) { return $email }
    return $osUser
}

function Get-OsLabel {
    # $IsMacOS / $IsLinux exist on PowerShell 6+; Windows PowerShell 5.1 is always Windows.
    if ($PSVersionTable.PSVersion.Major -lt 6) { return 'windows' }
    if ($IsMacOS) { return 'macos' }
    if ($IsLinux) { return 'linux' }
    return 'windows'
}

function Get-SessionId {
    # Claude Code exposes no session title, but it does expose a per-session UUID.
    # Eight characters is plenty to disambiguate concurrent sessions.
    $id = $env:CLAUDE_CODE_SESSION_ID
    if ($id) { return $id.Substring(0, [Math]::Min(8, $id.Length)) }
    return $null
}

$payload = @{ channel = $Channel; text = $Text }
if ($ThreadTs) { $payload['thread_ts'] = $ThreadTs }

if (-not $AsApp) {
    if (-not $Project) { $Project = Get-ProjectLabel }
    if (-not $User) {
        $wantEmail = $UserEmail.IsPresent -or ($env:CLAUDE_SLACK_USER_EMAIL -in @('1', 'true', 'yes'))
        $User = Get-ClaudeUser -IncludeEmail $wantEmail
    }
    if (-not $Machine) {
        $Machine = $env:CLAUDE_SLACK_MACHINE
        if (-not $Machine) { $Machine = $env:COMPUTERNAME }
        if (-not $Machine) { $Machine = [System.Net.Dns]::GetHostName() }
    }
    if (-not $Session) { $Session = Get-SessionLabel }



    # The display name is left alone: Slack shows the app's own name and avatar.
    # ALL the identifying detail lives in the context block instead, because the
    # display name clips silently at ~50 chars while a context block wraps.
    # Overriding the name or icon is opt-in via -Username / -IconEmoji, and that
    # is the ONLY path that needs the chat:write.customize scope.
    if ($Username) { $payload['username'] = $Username }
    if ($IconEmoji) { $payload['icon_emoji'] = $IconEmoji }

    # One element per facet, so Slack does the spacing rather than a separator
    # character. Identifiers are code-formatted; the human bits stay plain.
    $elements = @()
    if ($Project) { $elements += @{ type = 'mrkdwn'; text = "project: ``$Project``" } }
    if ($Session) { $elements += @{ type = 'mrkdwn'; text = "session: ``$Session``" } }
    if ($User) { $elements += @{ type = 'mrkdwn'; text = "user: $User" } }
    if ($Machine) { $elements += @{ type = 'mrkdwn'; text = "machine: $Machine" } }
    $elements += @{ type = 'mrkdwn'; text = "os: $(Get-OsLabel)" }

    # 'text' stays the raw message so push notifications and unfurls read correctly.
    if (-not $NoContext -and $elements.Count -gt 0) {
        $payload['blocks'] = @(
            @{ type = 'context'; elements = $elements },
            @{ type = 'section'; text = @{ type = 'mrkdwn'; text = $Text } }
        )
    }
    $ContextLine = (($elements | ForEach-Object { $_.text }) -join '  ')
}

# --- post -------------------------------------------------------------------

if ($DryRun) {
    Write-Host "DRY RUN - nothing sent."
    Write-Host "  channel  : $Channel"
    if ($AsApp) {
        Write-Host "  identity : (app default)"
    }
    else {
        if ($Username) { Write-Host "  username : $Username  (override)" }
        else { Write-Host "  username : (the app's own name)" }
        if ($IconEmoji) { Write-Host "  icon     : $IconEmoji  (override)" }
        else { Write-Host "  icon     : (the app's own avatar)" }
        if ($payload.ContainsKey('blocks')) {
            Write-Host "  context  : $ContextLine"
            Write-Host "             [$($elements.Count) elements]"
        }
        else {
            Write-Host "  context  : (none)"
        }
    }
    if ($ThreadTs) { Write-Host "  thread_ts: $ThreadTs" }
    Write-Host "  text     : $Text"
    exit 0
}

$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json; charset=utf-8' }

try {
    # -Depth matters: blocks nest four levels and the default of 2 silently
    # serialises the inner objects as type names instead of JSON.
    $r = Invoke-RestMethod -Uri 'https://slack.com/api/chat.postMessage' -Method Post -Headers $headers -Body ($payload | ConvertTo-Json -Depth 10 -Compress)
}
catch {
    Write-Error "Request to Slack failed: $($_.Exception.Message)"
    exit 1
}

if (-not $r.ok) {
    Write-Error "Slack rejected the post: $($r.error)"
    switch ($r.error) {
        'missing_scope' { Write-Host 'The app lacks chat:write.customize. Add it under Bot Token Scopes and reinstall, or pass -AsApp to post without a custom identity.' }
        'not_in_channel' { Write-Host 'The bot is not a member of that channel. In Slack, run: /invite @<app display name>' }
        'channel_not_found' { Write-Host 'Unknown channel id. Resolve it with mcp__slack__slack_search_channels.' }
        'invalid_auth' { Write-Host 'The bot token is stale - someone reinstalled the app. Re-copy it and re-run setx.' }
        'token_revoked' { Write-Host 'The bot token was revoked. Re-copy it from OAuth & Permissions and re-run setx.' }
    }
    exit 1
}

$as = if ($Username) { "as '$Username'" } else { 'as the app' }
$ctx = if ($payload.ContainsKey('blocks')) { " [$ContextLine]" } else { '' }
Write-Host "Posted to $($r.channel) $as$ctx - ts $($r.ts)"
