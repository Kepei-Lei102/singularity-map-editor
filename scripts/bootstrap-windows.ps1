param([string]$Project)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root '.runtime'
function Test-Node([string]$node) {
    try {
        & $node -e 'process.exit(parseInt(process.versions.node)>=22?0:1)' *> $null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
try {
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    $usable = $node -and $npm -and (Test-Node $node)
    if ($usable) { & $npm --version *> $null; $usable = $LASTEXITCODE -eq 0 }
    if (-not $usable) {
        $archName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        $arch = switch ($archName) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { throw "Unsupported Windows architecture: $archName" } }
        $target = Join-Path $cache "node-win-$arch"
        $node = Join-Path $target 'node.exe'
        $npmCli = Join-Path $target 'node_modules/npm/bin/npm-cli.js'
        $cached = (Test-Path $node) -and (Test-Node $node) -and (Test-Path $npmCli)
        if ($cached) { & $node $npmCli --version *> $null; $cached = $LASTEXITCODE -eq 0 }
        if (-not $cached) {
            New-Item -ItemType Directory -Force -Path $cache | Out-Null
            $work = Join-Path $cache ('download.' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $work | Out-Null
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            try {
                $ready = $false
                foreach ($base in @('https://npmmirror.com/mirrors/node', 'https://nodejs.org/dist')) {
                    try {
                        Write-Host "Preparing Node.js 22 LTS from $base ..."
                        $sums = Join-Path $work 'sums.txt'
                        Invoke-WebRequest -UseBasicParsing -Uri "$base/latest-v22.x/SHASUMS256.txt" -OutFile $sums -TimeoutSec 45
                        $pattern = "^([a-f0-9]{64})\s+(node-(v22\.[0-9]+\.[0-9]+)-win-$arch\.zip)$"
                        $match = Get-Content $sums | Select-String -Pattern $pattern | Select-Object -First 1
                        if (-not $match) { throw 'No matching Node archive in checksum list.' }
                        $hash = $match.Matches[0].Groups[1].Value
                        $file = $match.Matches[0].Groups[2].Value
                        $version = $match.Matches[0].Groups[3].Value
                        $zip = Join-Path $work 'archive.zip'
                        Invoke-WebRequest -UseBasicParsing -Uri "$base/$version/$file" -OutFile $zip -TimeoutSec 600
                        if ((Get-FileHash -Algorithm SHA256 $zip).Hash -ne $hash) { throw 'SHA-256 mismatch.' }
                        $extract = Join-Path $work ([Guid]::NewGuid().ToString('N'))
                        New-Item -ItemType Directory -Path $extract | Out-Null
                        Expand-Archive -LiteralPath $zip -DestinationPath $extract
                        $package = Join-Path $extract ($file -replace '\.zip$', '')
                        if (-not (Test-Node (Join-Path $package 'node.exe'))) { throw 'Downloaded Node cannot run.' }
                        & (Join-Path $package 'node.exe') (Join-Path $package 'node_modules/npm/bin/npm-cli.js') --version *> $null
                        if ($LASTEXITCODE -ne 0) { throw 'Downloaded npm cannot run.' }
                        if (Test-Path $target) { Move-Item -LiteralPath $target -Destination (Join-Path $work 'previous') }
                        Move-Item -LiteralPath $package -Destination $target
                        $ready = $true
                        break
                    } catch { Write-Warning $_.Exception.Message }
                }
                if (-not $ready) { throw 'Automatic Node setup failed. Check network, disk space and folder permissions, or install Node.js 22+ LTS from https://nodejs.org/ and retry.' }
            } finally { Remove-Item -LiteralPath $work -Recurse -Force }
        }
        $env:PATH = "$target;$env:PATH"
    }
    $launch = Join-Path $root 'scripts/launch.mjs'
    if ($Project) { & $node $launch $Project } else { & $node $launch }
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
