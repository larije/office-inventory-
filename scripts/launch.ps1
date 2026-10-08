param([switch]$Stop, [switch]$NoBrowser, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDirectory = if ($env:OFFICE_INVENTORY_DATA_DIR) { [IO.Path]::GetFullPath($env:OFFICE_INVENTORY_DATA_DIR) } else { Join-Path $root 'data' }
[int]$port = 3210
if ($env:OFFICE_INVENTORY_PORT -and (-not [int]::TryParse($env:OFFICE_INVENTORY_PORT, [ref]$port) -or $port -lt 1024 -or $port -gt 65535)) {
  Write-Host '[ERROR] OFFICE_INVENTORY_PORT must be between 1024 and 65535.'
  exit 1
}
$runtimeFile = Join-Path $dataDirectory 'runtime.json'
$actionLock = $null
$hash = [Security.Cryptography.SHA256]::Create()
try { $installationId = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataDirectory.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }

function Read-Health([int]$actualPort) {
  $response = $null
  try {
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:' + $actualPort + '/api/health')
    $request.Proxy = $null
    $request.Timeout = 1500
    $response = $request.GetResponse()
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  } catch {
    return $null
  } finally {
    if ($null -ne $response) { $response.Close() }
  }
}
function Read-Runtime {
  if (Test-Path -LiteralPath $runtimeFile) {
    try {
      $state = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
      [int]$actualPort = 0
      if ($state.app -ne 'office-inventory-v1' -or $state.installationId -ne $installationId -or
          -not [int]::TryParse([string]$state.port, [ref]$actualPort) -or $actualPort -lt 1024 -or $actualPort -gt 65535) { return $null }
      return $state
    } catch { return $null }
  }
  return $null
}
function Test-OurServer($health, $state) {
  return $null -ne $health -and $null -ne $state -and
    $health.app -eq 'office-inventory-v1' -and $state.app -eq $health.app -and
    $health.instanceId -eq $state.instanceId -and
    $health.installationId -eq $installationId -and $state.installationId -eq $installationId
}
function Test-RuntimeProcess($state) {
  [int]$runtimePid = 0
  if ($null -eq $state -or -not [int]::TryParse([string]$state.pid, [ref]$runtimePid) -or $runtimePid -lt 1) { return $false }
  try { $runtimeProcess = [Diagnostics.Process]::GetProcessById($runtimePid) }
  catch [ArgumentException] { return $false }
  try {
    if ($runtimeProcess.HasExited) { return $false }
    # A reused PID belongs to a process newer than the saved runtime record.
    return $runtimeProcess.StartTime.ToUniversalTime() -le (Get-Item -LiteralPath $runtimeFile).LastWriteTimeUtc
  } catch {
    # If process details cannot be read, do not risk opening the data twice.
    return $true
  } finally { $runtimeProcess.Dispose() }
}
function Open-InventoryBrowser([string]$Url, [string[]]$Candidates = @(
  (Join-Path $env:ProgramFiles 'Zen Browser\zen.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\zen-browser\zen.exe')
)) {
  foreach ($candidate in $Candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      try {
        Start-Process -FilePath $candidate -ArgumentList $Url | Out-Null
        Write-Host '[OK] Opened in Zen Browser.'
        return
      } catch {
        Write-Host '[WARN] Zen Browser could not open. Trying your default browser.' -ForegroundColor Yellow
        break
      }
    }
  }
  try {
    Start-Process -FilePath $Url | Out-Null
    Write-Host '[OK] Opened in your default browser.'
  } catch {
    Write-Host "[WARN] The browser could not open automatically. Open $Url to use Inventory." -ForegroundColor Yellow
  }
}
function New-InventoryShortcut([string]$AppRoot, [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop')) {
  $shell = $null
  $shortcut = $null
  try {
    if (-not $DesktopDirectory -or -not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) {
      throw 'The Desktop folder is unavailable.'
    }
    $shortcutPath = Join-Path $DesktopDirectory 'Start Inventory.lnk'
    # A shortcut with this name may belong to another portable Inventory folder.
    if (Test-Path -LiteralPath $shortcutPath) {
      Write-Host '[INFO] Keeping the existing Start Inventory desktop shortcut.'
      return
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $AppRoot 'Start Inventory.bat'
    $shortcut.WorkingDirectory = $AppRoot
    $shortcut.WindowStyle = 1
    $shortcut.Description = 'Start Office Inventory'
    $shortcut.Save()
    Write-Host '[OK] Created the Start Inventory desktop shortcut.'
  } catch {
    Write-Host '[WARN] The desktop shortcut could not be created. You can still use Start Inventory.bat.' -ForegroundColor Yellow
  } finally {
    if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  }
}
try {
  Write-Host ''
  Write-Host ' =====================================================' -ForegroundColor Cyan
  if ($Stop) { Write-Host '   Office Inventory - Stopping the system' -ForegroundColor Cyan }
  else { Write-Host '   Office Inventory - Starting the system' -ForegroundColor Cyan }
  Write-Host ' =====================================================' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '[INFO] Checking this Inventory folder...'
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  try { $actionLock = [IO.File]::Open((Join-Path $dataDirectory 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch [IO.IOException] { throw 'Inventory is already starting or stopping. Please wait a moment and try again.' }
  $state = Read-Runtime
  $health = if ($null -ne $state) { Read-Health $state.port } else { $null }
  $running = Test-OurServer $health $state
  if (-not $running -and (Test-RuntimeProcess $state)) {
    throw 'This Inventory folder still has a running process that is not responding. Wait a moment and try again. A second copy has not been started.'
  }
  if ($Stop) {
    if (-not $running) {
      Write-Host '[OK] Office Inventory is already stopped.'
    } else {
      Write-Host '[INFO] Saving records and stopping Office Inventory...'
      $url = 'http://127.0.0.1:' + $state.port
      $request = [Net.HttpWebRequest]::Create($url + '/internal/shutdown')
      $request.Proxy = $null
      $request.Timeout = 5000
      $request.Method = 'POST'
      $request.ContentLength = 0
      $request.Headers['Authorization'] = 'Bearer ' + $state.shutdownToken
      $response = $request.GetResponse()
      $response.Close()
      for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $current = Read-Runtime
        if (-not (Test-OurServer (Read-Health $state.port) $state) -and
            ($null -eq $current -or $current.instanceId -ne $state.instanceId)) { break }
        Start-Sleep -Milliseconds 200
      }
      if (Test-OurServer (Read-Health $state.port) $state) { throw 'The app is still stopping. Wait a moment before restarting.' }
      Write-Host '[OK] Office Inventory stopped. Your records are saved.'
    }
  } else {
    if (-not $running) {
      Write-Host '[INFO] Checking the portable runtime...'
      $node = Join-Path $root 'runtime\node.exe'
      if (-not (Test-Path -LiteralPath $node)) {
        $command = Get-Command node -ErrorAction SilentlyContinue
        if ($null -eq $command) { throw 'The runtime is missing. Extract the complete Office Inventory ZIP, including its runtime folder.' }
        $node = $command.Source
      }
      $nodeVersion = (& $node --version).TrimStart('v').Trim()
      if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'24.17.0') { throw 'Node.js 24.17 or later is required. Use the bundled runtime.' }
      Write-Host '[OK] The runtime is ready.'
      $env:OFFICE_INVENTORY_DATA_DIR = $dataDirectory
      $env:OFFICE_INVENTORY_PORT = [string]$port
      $serverScript = Join-Path $root 'src\server.mjs'
      $stdout = Join-Path $dataDirectory 'server.log'
      $stderr = Join-Path $dataDirectory 'server-error.log'
      Write-Host '[INFO] Starting Office Inventory in the background...'
      $server = Start-Process -FilePath $node -ArgumentList ('"' + $serverScript + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
      Write-Host '[INFO] Waiting for Office Inventory to be ready...'
      $ready = $false
      for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $server.Refresh()
        if ($server.HasExited) { throw "Inventory could not start. See $stderr." }
        $state = Read-Runtime
        $health = if ($null -ne $state) { Read-Health $state.port } else { $null }
        if ((Test-OurServer $health $state) -and $state.pid -eq $server.Id) { $ready = $true; break }
        Start-Sleep -Milliseconds 250
      }
      if (-not $ready) { throw "Inventory is taking longer to open. Check $stderr, then run Start Inventory again." }
    } else {
      Write-Host '[OK] Reusing the Office Inventory app already running from this folder.'
    }
    $url = 'http://127.0.0.1:' + $state.port
    Write-Host ''
    Write-Host "[OK] Office Inventory is ready at $url" -ForegroundColor Green
    Write-Host 'The app keeps running after this window closes. Use Stop Inventory.bat to close it.'
    if (-not $NoShortcut) { New-InventoryShortcut -AppRoot $root }
    if (-not $NoBrowser) { Open-InventoryBrowser -Url $url }
  }
} catch {
  Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($null -ne $actionLock) { $actionLock.Dispose() }
}
