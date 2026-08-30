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
    OS user label. Default: $env:USERNAME (Windows) or $env:USER (Unix). Rendered as
    <user>@<machine>.

.PARAMETER Machine
    Machine label. Default: $env:CLAUDE_SLACK_MACHINE, else the computer name.
    Set CLAUDE_SLACK_MACHINE to something friendlier than a Windows default like
    DESKTOP-HBNGBFQ.

.PARAMETER Session
    Human-meaningful session label. Default: $env:CLAUDE_SESSION_NAME, else the current
    git branch. Rendered as <session>#<id>.

    Claude Code does not expose a session *title* - it writes conversation summaries
    only on compaction, so there is nothing to read at post time. Branch is the most
    meaningful thing available automatically; set CLAUDE_SESSION_NAME for anything better.

.PARAMETER NoSessionId
    Omit the short session id. It is appended by default because a branch is NOT unique -
    two concurrent sessions on the same branch would otherwise render identically.

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
    [switch]$NoSessionId,
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
    if ($env:CLAUDE_SESSION_NAME) { return $env:CLAUDE_SESSION_NAME }
    try {
        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $branch -and $branch -ne 'HEAD') { return $branch }
    }
    catch { }
    return $null
}

function Get-SessionId {
    # Claude Code exposes no session title, but it does expose a per-session UUID.
    # Eight characters is plenty to disambiguate concurrent sessions.
    $id = $env:CLAUDE_CODE_SESSION_ID
    if ($id) { return $id.Substring(0, [Math]::Min(8, $id.Length)) }
    return $null
}

function Get-OsIcon {
    # $IsMacOS / $IsLinux exist on PowerShell 6+; Windows PowerShell 5.1 is always Windows.
    if ($PSVersionTable.PSVersion.Major -lt 6) { return ':desktop_computer:' }
    if ($IsMacOS) { return ':apple:' }
    if ($IsLinux) { return ':penguin:' }
    return ':desktop_computer:'
}

$payload = @{ channel = $Channel; text = $Text }
if ($ThreadTs) { $payload['thread_ts'] = $ThreadTs }

if (-not $AsApp) {
    if (-not $Project) { $Project = Get-ProjectLabel }
    if (-not $User) {
        $User = $env:USERNAME
        if (-not $User) { $User = $env:USER }
    }
    if (-not $Machine) {
        $Machine = $env:CLAUDE_SLACK_MACHINE
        if (-not $Machine) { $Machine = $env:COMPUTERNAME }
        if (-not $Machine) { $Machine = [System.Net.Dns]::GetHostName() }
    }
    if (-not $Session) { $Session = Get-SessionLabel }

    if (-not $Username) {
        # who: user@machine, falling back to whichever half we have
        $who = (@($User, $Machine) | Where-Object { $_ }) -join '@'

        # which: session#id - the id is what actually guarantees uniqueness,
        # since a branch name is shared by every session on that branch.
        $id = if ($NoSessionId) { $null } else { Get-SessionId }
        $which = (@($Session, $id) | Where-Object { $_ }) -join '#'

        # Slack clips the display name at roughly 50 visible characters, so the
        # name carries only what must always be visible - who and which project.
        # The precise session identity goes in a context block on the message,
        # where there is room. Separator is a middle dot, built from its code
        # point so this file stays pure ASCII and cannot be mangled by encoding.
        $sep = [char]0x00B7
        $Username = (@('Claude', $Project) | Where-Object { $_ }) -join $sep
    }
    # Slack's hard cap is higher than this, but ~50 chars is all that renders.
    if ($Username.Length -gt 48) { $Username = $Username.Substring(0, 47) + [char]0x2026 }

    # The full identity, for the context line.
    $sep = [char]0x00B7
    $ContextLine = (@($which, $who) | Where-Object { $_ }) -join " $sep "

    if (-not $IconEmoji) { $IconEmoji = Get-OsIcon }

    $payload['username'] = $Username
    $payload['icon_emoji'] = $IconEmoji

    # A context block renders as small muted text above the message - room for the
    # full identity without competing with the body. 'text' stays the raw message
    # so push notifications and unfurls read correctly.
    if (-not $NoContext -and $ContextLine) {
        $payload['blocks'] = @(
            @{
                type     = 'context'
                elements = @( @{ type = 'mrkdwn'; text = "$IconEmoji  $ContextLine" } )
            },
            @{
                type = 'section'
                text = @{ type = 'mrkdwn'; text = $Text }
            }
        )
    }
}

# --- post -------------------------------------------------------------------

if ($DryRun) {
    Write-Host "DRY RUN - nothing sent."
    Write-Host "  channel  : $Channel"
    if ($AsApp) {
        Write-Host "  identity : (app default)"
    }
    else {
        Write-Host "  username : $Username  [$($Username.Length) chars]"
        Write-Host "  icon     : $IconEmoji"
        if ($payload.ContainsKey('blocks')) {
            Write-Host "  context  : $IconEmoji  $ContextLine"
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

if ($AsApp) {
    Write-Host "Posted to $($r.channel) as the app - ts $($r.ts)"
}
else {
    Write-Host "Posted to $($r.channel) as '$Username' $IconEmoji - ts $($r.ts)"
}
