$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $appRoot 'scripts\launch.ps1'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('inventory-port-test-' + [Guid]::NewGuid().ToString('N'))
$firstData = Join-Path $fixtureRoot 'first office'
$secondData = Join-Path $fixtureRoot 'second office'
$blockedData = Join-Path $fixtureRoot 'unresponsive office'
$originalPort = $env:OFFICE_INVENTORY_PORT
$originalData = $env:OFFICE_INVENTORY_DATA_DIR
$firstBlocker = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$secondBlocker = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$ownedStates = @()

function Invoke-Launcher([switch]$Stop, [switch]$ExpectFailure) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $launcher + '"'), '-NoBrowser', '-NoShortcut')
  if ($Stop) { $arguments += '-Stop' }
  $logPrefix = Join-Path $fixtureRoot ([Guid]::NewGuid().ToString('N'))
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput ($logPrefix + '.log') -RedirectStandardError ($logPrefix + '.error.log') -PassThru
  $launcherHandle = $process.Handle
  # Wait for the launcher itself, not the detached server's inherited pipe handles.
  if (-not $process.WaitForExit(30000)) { throw 'Launcher did not return within 30 seconds.' }
  $process.Refresh()
  $code = $process.ExitCode
  $process.Dispose()
  $lines = @(Get-Content -LiteralPath ($logPrefix + '.log')) + @(Get-Content -LiteralPath ($logPrefix + '.error.log'))
  if ($ExpectFailure) {
    if ($code -eq 0) { throw 'An unresponsive live instance was allowed to start a duplicate.' }
  } elseif ($code -ne 0) { throw ('Launcher failed: ' + ($lines -join ' ')) }
  return ($lines -join "`n")
}
function Read-State([string]$directory) {
  return Get-Content -Raw -LiteralPath (Join-Path $directory 'runtime.json') | ConvertFrom-Json
}
function Get-Url($state) { return 'http://127.0.0.1:' + $state.port }
function Stop-Owned($state) {
  try {
    $url = Get-Url $state
    $health = Invoke-RestMethod ($url + '/api/health') -TimeoutSec 2
    if ($health.instanceId -eq $state.instanceId -and $health.installationId -eq $state.installationId) {
      Invoke-RestMethod ($url + '/internal/shutdown') -Method Post -Headers @{ Authorization = 'Bearer ' + $state.shutdownToken } -TimeoutSec 3 | Out-Null
    }
  } catch { }
}
function Test-LauncherExperience {
  # Load just the helpers. The real Desktop and browser must never be touched by tests.
  $parseErrors = $null
  $tokens = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ('Launcher syntax error: ' + $parseErrors[0].Message) }
  foreach ($name in @('Open-InventoryBrowser', 'New-InventoryShortcut')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if ($null -eq $definition) { throw "Missing launcher helper: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $messages = [Collections.Generic.List[string]]::new()
  function Write-Host([object]$Object, [string]$ForegroundColor) { $messages.Add([string]$Object) }
  $browserLaunches = [Collections.Generic.List[object]]::new()
  $failZen = $false
  $failDefault = $false
  function Start-Process([string]$FilePath, [string]$ArgumentList) {
    $browserLaunches.Add(@{ file = $FilePath; arguments = $ArgumentList })
    if (($failZen -and $FilePath -eq $fakeZen) -or ($failDefault -and $FilePath -eq $testUrl)) { throw 'Simulated browser failure.' }
  }
  $fakeZen = Join-Path $fixtureRoot 'Zen Browser\zen.exe'
  New-Item -ItemType Directory -Path (Split-Path $fakeZen) -Force | Out-Null
  New-Item -ItemType File -Path $fakeZen | Out-Null
  $missingZen = Join-Path $fixtureRoot 'missing-zen.exe'
  $testUrl = 'http://127.0.0.1:54321'
  Open-InventoryBrowser -Url $testUrl -Candidates @($missingZen, $fakeZen)
  if ($browserLaunches.Count -ne 1 -or $browserLaunches[0].file -ne $fakeZen -or $browserLaunches[0].arguments -ne $testUrl) { throw 'Zen Browser did not receive the actual app URL.' }
  $browserLaunches.Clear()
  Open-InventoryBrowser -Url $testUrl -Candidates @($missingZen)
  if ($browserLaunches.Count -ne 1 -or $browserLaunches[0].file -ne $testUrl) { throw 'Missing Zen Browser did not fall back to the default browser.' }
  $browserLaunches.Clear()
  $failZen = $true
  Open-InventoryBrowser -Url $testUrl -Candidates @($fakeZen)
  if ($browserLaunches.Count -ne 2 -or $browserLaunches[1].file -ne $testUrl) { throw 'Failed Zen Browser did not fall back to the default browser.' }
  $failDefault = $true
  $messages.Clear()
  Open-InventoryBrowser -Url $testUrl -Candidates @($missingZen)
  if (-not (($messages -join ' ').Contains($testUrl))) { throw 'Browser failure did not leave the usable app URL.' }

  $testDesktop = Join-Path $fixtureRoot 'isolated desktop'
  New-Item -ItemType Directory -Path $testDesktop | Out-Null
  New-InventoryShortcut -AppRoot $appRoot -DesktopDirectory $testDesktop
  $shortcutPath = Join-Path $testDesktop 'Start Inventory.lnk'
  if (-not (Test-Path -LiteralPath $shortcutPath)) { throw 'The first launch did not create a shortcut.' }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  try {
    if ($shortcut.TargetPath -ne (Join-Path $appRoot 'Start Inventory.bat') -or $shortcut.WorkingDirectory -ne $appRoot) { throw 'The desktop shortcut points to the wrong installation.' }
    $shortcut.TargetPath = Join-Path $fixtureRoot 'another inventory\Start Inventory.bat'
    $shortcut.Save()
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
  $shortcutHash = (Get-FileHash -LiteralPath $shortcutPath).Hash
  New-InventoryShortcut -AppRoot $appRoot -DesktopDirectory $testDesktop
  if ((Get-FileHash -LiteralPath $shortcutPath).Hash -ne $shortcutHash) { throw 'An existing shortcut to another installation was overwritten.' }
  $messages.Clear()
  New-InventoryShortcut -AppRoot $appRoot -DesktopDirectory (Join-Path $fixtureRoot 'missing desktop')
  if (-not (($messages -join ' ').Contains('[WARN]'))) { throw 'An unavailable desktop did not produce a nonfatal warning.' }
}

try {
  New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
  Test-LauncherExperience
  $firstBlocker.Start()
  $secondBlocker.Start()
  $env:OFFICE_INVENTORY_PORT = [string]$firstBlocker.LocalEndpoint.Port
  $env:OFFICE_INVENTORY_DATA_DIR = $firstData
  $launchOutput = Invoke-Launcher
  $first = Read-State $firstData
  $ownedStates += $first
  if ($first.port -eq $firstBlocker.LocalEndpoint.Port) { throw 'The occupied port was reused.' }
  $firstUrl = Get-Url $first
  if (-not $launchOutput.Contains($firstUrl)) { throw 'Launcher did not report the actual ready URL.' }
  if (-not $launchOutput.Contains('[INFO] Checking the portable runtime...') -or -not $launchOutput.Contains('[INFO] Waiting for Office Inventory to be ready...')) { throw 'Startup progress was not reported.' }
  $health = Invoke-RestMethod ($firstUrl + '/api/health')
  if ($health.instanceId -ne $first.instanceId) { throw 'The fallback app is not healthy.' }
  Invoke-RestMethod ($firstUrl + '/api/equipment') -Method Post -ContentType 'application/json' -Headers @{ 'X-Inventory-Request'='1' } -Body '{"propertyNumber":"PORT-TEST","name":"Port test equipment"}' | Out-Null

  $env:OFFICE_INVENTORY_PORT = [string]$secondBlocker.LocalEndpoint.Port
  $repeatOutput = Invoke-Launcher
  if ((Read-State $firstData).instanceId -ne $first.instanceId) { throw 'Repeat start duplicated the running inventory.' }
  if (-not $repeatOutput.Contains('[OK] Reusing the Office Inventory app already running from this folder.')) { throw 'Repeated launch did not explain that the existing app was reused.' }
  Invoke-Launcher -Stop | Out-Null
  if (Test-Path -LiteralPath (Join-Path $firstData 'runtime.json')) { throw 'Stop did not find and stop the actual port.' }
  if (-not $firstBlocker.Server.IsBound -or -not $secondBlocker.Server.IsBound) { throw 'An unrelated listener was stopped.' }

  # A stale runtime file must not prevent a clean restart with the same records.
  $first | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $firstData 'runtime.json') -Encoding UTF8
  Invoke-Launcher | Out-Null
  $restarted = Read-State $firstData
  $ownedStates += $restarted
  if ($restarted.instanceId -eq $first.instanceId) { throw 'Stale runtime was treated as a running instance.' }
  $records = Invoke-RestMethod ((Get-Url $restarted) + '/api/state')
  if ($records.equipment.Count -ne 1 -or $records.equipment[0].propertyNumber -ne 'PORT-TEST') { throw 'Changing ports lost the existing records.' }

  # A second folder can coexist; its Stop command must leave the first alive.
  $env:OFFICE_INVENTORY_PORT = [string]$restarted.port
  $env:OFFICE_INVENTORY_DATA_DIR = $secondData
  Invoke-Launcher | Out-Null
  $second = Read-State $secondData
  $ownedStates += $second
  if ($second.port -eq $restarted.port -or $second.installationId -eq $restarted.installationId) { throw 'Separate inventory folders were mixed.' }
  Invoke-Launcher -Stop | Out-Null
  if ((Invoke-RestMethod ((Get-Url $restarted) + '/api/health')).instanceId -ne $restarted.instanceId) { throw 'Stopping the second folder stopped the first.' }
  $env:OFFICE_INVENTORY_DATA_DIR = $firstData
  Invoke-Launcher -Stop | Out-Null

  # A valid runtime pointing to a live but unresponsive process is not stale.
  New-Item -ItemType Directory -Path $blockedData -Force | Out-Null
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $installationId = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($blockedData.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
  @{ app='office-inventory-v1'; installationId=$installationId; instanceId='unresponsive-test'; pid=$PID; port=$firstBlocker.LocalEndpoint.Port; shutdownToken='unused' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $blockedData 'runtime.json') -Encoding UTF8
  $env:OFFICE_INVENTORY_DATA_DIR = $blockedData
  Invoke-Launcher -ExpectFailure | Out-Null
  if (Test-Path -LiteralPath (Join-Path $blockedData 'inventory.sqlite')) { throw 'A duplicate inventory opened while its process was unresponsive.' }
  Write-Output 'PASS: Zen preference and default-browser fallback; browser failures retain the app URL; isolated desktop shortcut creation; existing shortcut preserved; shortcut failure is nonfatal; startup progress; occupied port fallback; correct URL; repeated start and Stop follow actual port; stale runtime recovery; records persist; separate folders stop independently; live unresponsive instance is not duplicated.'
} finally {
  foreach ($directory in @($firstData, $secondData)) {
    if (Test-Path -LiteralPath (Join-Path $directory 'runtime.json')) { $ownedStates += Read-State $directory }
  }
  foreach ($state in $ownedStates) { Stop-Owned $state }
  $firstBlocker.Stop()
  $secondBlocker.Stop()
  $env:OFFICE_INVENTORY_PORT = $originalPort
  $env:OFFICE_INVENTORY_DATA_DIR = $originalData
  # Keep isolated fixtures for failure diagnosis; no user inventory is modified.
}
