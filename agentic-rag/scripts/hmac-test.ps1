param(
    [Parameter(Mandatory)][string]$Secret,
    [string]$KeyId = "local-debug",
    [string]$Url = "http://localhost:3002",
    [string]$Question = "hola",
    [int]$TimestampOffset = 0,
    [string]$PathOverride = $null
)

$ErrorActionPreference = "Stop"

$ts = [int][double]::Parse((Get-Date -UFormat %s)) + $TimestampOffset
$path = if ($PathOverride) { $PathOverride } else { "/api/chat/stream" }
$body = ""

# sha256("") -> e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
$bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
$canonical = "$ts`nGET`n$path`n$bodyHash"
$sig = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($canonical))) -Algorithm SHA256 `
        -Key ([Text.Encoding]::UTF8.GetBytes($Secret))).Hash.ToLower()

Write-Host "=== HMAC debug ===" -ForegroundColor Cyan
Write-Host "timestamp       : $ts"
Write-Host "key id          : $KeyId"
Write-Host "path            : $path"
Write-Host "body sha256     : $bodyHash"
Write-Host "canonical       : $($canonical -replace "`n","\n")"
Write-Host "signature (hex) : $sig"
Write-Host ""

$headers = @{
    "X-Floci-Timestamp" = "$ts"
    "X-Floci-Key-Id"    = $KeyId
    "X-Floci-Signature" = $sig
    "Accept"            = "text/event-stream"
}

Write-Host "=== curl ===" -ForegroundColor Cyan
$query = "q=$( [uri]::EscapeDataString($Question) )"
try {
    Invoke-WebRequest -Uri "$Url$($path)?$query" -Headers $headers -Method GET -TimeoutSec 15 `
        -ErrorAction Stop 2>&1 | Select-Object -First 5
} catch {
    Write-Host "Response: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Yellow
    try {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $bodyText = $reader.ReadToEnd()
        Write-Host "Body: $bodyText" -ForegroundColor Yellow
    } catch { }
}
