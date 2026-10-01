# Eagles Nest Chat - offline chatroom (tools/offline-chatroom.ps1)
# A local scratch chat in your console. What you type is saved only on this PC (offline-chatroom.log
# next to this script); /sync prints the public last-5 tail of the Milliway room.
# Read-only toward the server: the only network call is an HTTPS GET of the public
# https://chat.afirstflag.com/last5.txt (nothing is uploaded: no POST/PUT, no query string, no login).
# License: MIT (see LICENSE in https://github.com/Cremea06/eagles-nest-chat).
#
# offline-chatroom.ps1 - local scratch chat with pull-only sync from chat.afirstflag.com
# Compatible with Windows PowerShell 5.1 (and PowerShell 7).
#
#   you> anything      -> printed as [local] ... and appended (timestamped) to offline-chatroom.log
#   you> /sync         -> fetch https://chat.afirstflag.com/last5.txt and print it (download only, never uploads)
#   you> /quit         -> exit
#
# /sync result classification:
#   HTTP 200 with text      -> the text is printed
#   HTTP 200 but empty      -> 'no remote file yet'
#   HTTP 404                -> 'no remote file yet'
#   no HTTP response at all -> 'offline'  (DNS failure, no network, connection refused, TLS failure, timeout)
#   any other HTTP status   -> 'offline (HTTP <code>)'  (e.g. 502/503 from the proxy when the chat server is down)

$SyncUrl = 'https://chat.afirstflag.com/last5.txt'

# Windows PowerShell 5.1 on older .NET may not offer TLS 1.2 by default; add it (harmless on PS 7).
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # ignore: not available / not needed on this runtime
}

# Log next to the script; fall back to the current directory when pasted into a console.
$baseDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($baseDir)) {
    $baseDir = (Get-Location).Path
}
$LogPath = Join-Path $baseDir 'offline-chatroom.log'

function Write-LocalLine {
    param([string]$Text)
    Write-Host "[local] $Text"
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    try {
        Add-Content -Path $LogPath -Value "$stamp [local] $Text" -Encoding UTF8 -ErrorAction Stop
    } catch {
        Write-Host "(could not write log $LogPath : $($_.Exception.Message))"
    }
}

function Invoke-Sync {
    try {
        $resp = Invoke-WebRequest -Uri $SyncUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    } catch {
        $err = $_
        $httpResp = $null
        if ($err.Exception -and $err.Exception.PSObject.Properties['Response']) {
            $httpResp = $err.Exception.Response
        }
        if ($null -eq $httpResp) {
            # No HTTP response: DNS, network down, refused, TLS or timeout.
            Write-Host 'offline'
            return
        }
        $code = 0
        try { $code = [int]$httpResp.StatusCode } catch { $code = 0 }
        if ($code -eq 404) {
            Write-Host 'no remote file yet'
        } elseif ($code -gt 0) {
            Write-Host "offline (HTTP $code)"
        } else {
            Write-Host 'offline'
        }
        return
    }

    $content = $resp.Content
    if ($content -is [byte[]]) {
        $content = [System.Text.Encoding]::UTF8.GetString($content)
    }
    if ($null -eq $content) {
        $content = ''
    }
    $content = [string]$content
    if ($content.Trim().Length -eq 0) {
        Write-Host 'no remote file yet'
        return
    }
    foreach ($l in ($content -split "`n")) {
        $l = $l.TrimEnd([char]13)
        if ($l.Length -gt 0) {
            Write-Host $l
        }
    }
}

while ($true) {
    $raw = Read-Host 'you'
    if ($null -eq $raw) {
        break
    }
    $line = $raw.Trim()
    if ($line.Length -eq 0) {
        continue
    }
    if ($line -ieq '/quit') {
        break
    }
    if ($line -ieq '/sync') {
        Invoke-Sync
        continue
    }
    Write-LocalLine $line
}
