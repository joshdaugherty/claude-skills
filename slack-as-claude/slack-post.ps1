<#
.SYNOPSIS
    Posts a Slack message as the app rather than as the signed-in human.

.DESCRIPTION
    Slack's MCP server (mcp.slack.com) is user-token-only, so anything sent through
    the mcp__slack__* tools is attributed to the human's own account with no "via app"
    marker. This script uses the app's BOT token against the plain Web API instead, so
    the message lands with an APP badge under the bot's own identity.

    The token is read from the SLACK_BOT_TOKEN *user* environment variable via the
    registry rather than $env:, because setx writes to HKCU\Environment while a running
    process keeps the environment block it inherited at launch. The token is never printed.

    See the SKILL.md beside this file for setup, the identity split, and the traps.

.PARAMETER Channel
    Channel ID (e.g. C01234ABCDE). Resolve names to ids with mcp__slack__slack_search_channels;
    the bot token cannot look them up itself.

    The bot must have been invited to the channel with /invite @<app display name>,
    or the post fails with not_in_channel.

.PARAMETER Text
    The message body.

.PARAMETER ThreadTs
    Optional ts of a parent message, to reply in a thread instead of the channel.

.EXAMPLE
    .\slack-post.ps1 -Channel C01234ABCDE -Text "Test suite green, 412 passed."

.EXAMPLE
    .\slack-post.ps1 -Channel C01234ABCDE -Text "Full log attached." -ThreadTs 1788055161.122969
#>
param(
    [Parameter(Mandatory = $true)][string]$Channel,
    [Parameter(Mandatory = $true)][string]$Text,
    [string]$ThreadTs
)

$ErrorActionPreference = 'Stop'

$token = [Environment]::GetEnvironmentVariable('SLACK_BOT_TOKEN', 'User')
if (-not $token) {
    Write-Error 'SLACK_BOT_TOKEN is not set at User scope. Set it with: setx SLACK_BOT_TOKEN "xoxb-..."'
    exit 1
}

$payload = @{ channel = $Channel; text = $Text }
if ($ThreadTs) { $payload['thread_ts'] = $ThreadTs }

$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json; charset=utf-8' }

try {
    $r = Invoke-RestMethod -Uri 'https://slack.com/api/chat.postMessage' -Method Post -Headers $headers -Body ($payload | ConvertTo-Json -Compress)
}
catch {
    Write-Error "Request to Slack failed: $($_.Exception.Message)"
    exit 1
}

if (-not $r.ok) {
    Write-Error "Slack rejected the post: $($r.error)"
    switch ($r.error) {
        'not_in_channel' { Write-Host 'The bot is not a member of that channel. In Slack, run: /invite @<app display name>' }
        'channel_not_found' { Write-Host 'Unknown channel id. Resolve it with mcp__slack__slack_search_channels.' }
        'invalid_auth' { Write-Host 'The bot token is stale - someone reinstalled the app. Re-copy it and re-run setx.' }
        'token_revoked' { Write-Host 'The bot token was revoked. Re-copy it from OAuth & Permissions and re-run setx.' }
    }
    exit 1
}

Write-Host "Posted to $($r.channel) as bot $($r.message.bot_id) - ts $($r.ts)"
