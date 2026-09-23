[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Native commands are checked explicitly. Each invocation temporarily uses
# Continue because Windows PowerShell 5.1 represents redirected native stderr
# as ErrorRecord objects and would otherwise promote harmless progress output
# to a terminating error when the script-wide preference is Stop.

$repoRoot = Split-Path -Parent $PSScriptRoot
$originalLocation = Get-Location
$projectName = "opsflow-m1-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$workerContainer = "$projectName-worker"
$workerImage = "$projectName-worker:gate"
$workerContext = Join-Path ([IO.Path]::GetTempPath()) "$projectName-worker-context"
$probeMarker = [Guid]::NewGuid().ToString('N')
$redisProbeKey = 'opsflow:infrastructure-gate:marker'
$composeFile = Join-Path $repoRoot 'docker-compose.yml'
$environmentFile = Join-Path $repoRoot '.env.example'
$composeArguments = @(
  'compose'
  '--project-name'
  $projectName
  '--env-file'
  $environmentFile
  '--file'
  $composeFile
)

$environmentNames = @(
  'NODE_ENV'
  'POSTGRES_PASSWORD'
  'POSTGRES_PORT'
  'REDIS_PORT'
  'DATABASE_URL'
  'REDIS_URL'
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  $originalEnvironment[$name] = if ($null -eq $item) { $null } else { $item.Value }
}

$composeLifecycleStarted = $false
$workerContainerCreated = $false
$workerImageCreated = $false
$workerContextCreated = $false
$cleanupStarted = $false
$cleanupErrors = [Collections.Generic.List[string]]::new()
$primaryFailure = $null

function Write-GateStep {
  param([Parameter(Mandatory)][string]$Message)

  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory)][string]$Description,
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$ArgumentList,
    [switch]$CaptureOutput
  )

  try {
    $commandInfo = Get-Command -Name $FilePath -ErrorAction Stop
    $commandPath = $commandInfo.Path
    if (-not $commandPath) {
      throw "Resolved command '$FilePath' has no executable path."
    }
  }
  catch {
    throw "$Description could not start: $($_.Exception.Message)"
  }

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    # Invoke the path rather than the CommandInfo object. Windows PowerShell
    # 5.1 tries to read a nonexistent Statement property when an
    # ExternalScriptInfo such as npm.ps1 is passed directly to the call
    # operator.
    $output = & $commandPath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $text = (($output | ForEach-Object { "$_" }) -join "`n").Trim()
  if ($text) {
    Write-Host $text
  }

  if ($exitCode -ne 0) {
    Write-Host "$Description exit code: $exitCode"
    throw "$Description failed with exit code $exitCode."
  }

  if ($CaptureOutput) {
    return $text
  }

  Write-Host "$Description exit code: $exitCode"
}

function Invoke-CleanupCommand {
  param(
    [Parameter(Mandatory)][string]$Description,
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$ArgumentList
  )

  try {
    $commandInfo = Get-Command -Name $FilePath -ErrorAction Stop
    $commandPath = $commandInfo.Path
    if (-not $commandPath) {
      throw "Resolved command '$FilePath' has no executable path."
    }
  }
  catch {
    $script:cleanupErrors.Add("$Description could not start: $($_.Exception.Message)")
    return
  }

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $commandPath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
  }
  catch {
    $script:cleanupErrors.Add("$Description could not run: $($_.Exception.Message)")
    return
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -eq 0) {
    $text = (($output | ForEach-Object { "$_" }) -join "`n").Trim()
    if ($text) {
      Write-Host $text
    }
    return
  }

  $text = (($output | ForEach-Object { "$_" }) -join "`n").Trim()
  $isHarmlessMissingResource =
    $text -match '(?i)(no such (container|image|network|volume)|not found|does not exist)' -and
    $text -notmatch '(?i)(permission denied|access is denied|cannot connect|connection refused)'

  if ($isHarmlessMissingResource) {
    Write-Host "Cleanup skipped an already absent disposable resource: $Description"
    return
  }

  $detail = if ($text) { ": $text" } else { '' }
  $script:cleanupErrors.Add("$Description failed with exit code $exitCode$detail")
}

function Get-AvailableTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Get-ProjectResourceIds {
  $resourceIds = [Collections.Generic.List[string]]::new()
  foreach ($resourceType in @('container', 'volume', 'network')) {
    $noun = if ($resourceType -eq 'container') { 'ps' } else { $resourceType }
    $arguments = if ($resourceType -eq 'container') {
      @('ps', '--all', '--quiet', '--filter', "label=com.docker.compose.project=$projectName")
    }
    else {
      @($noun, 'ls', '--quiet', '--filter', "label=com.docker.compose.project=$projectName")
    }
    $ids = Invoke-NativeCommand -Description "Docker $resourceType lookup" -FilePath 'docker' -ArgumentList $arguments -CaptureOutput
    if ($ids) {
      foreach ($id in ($ids -split "`r?`n")) {
        if ($id.Trim()) {
          $resourceIds.Add("${resourceType}:$($id.Trim())")
        }
      }
    }
  }
  return $resourceIds.ToArray()
}

function Copy-GateFile {
  param([Parameter(Mandatory)][string]$RelativePath)

  $source = Join-Path $repoRoot $RelativePath
  $destination = Join-Path $workerContext $RelativePath
  $destinationDirectory = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Wait-ForWorkerReadiness {
  param([Parameter(Mandatory)][int]$TimeoutSeconds)

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $logs = Invoke-NativeCommand -Description 'Worker log inspection' -FilePath 'docker' -ArgumentList @('logs', $workerContainer) -CaptureOutput
    if ($logs -match 'OpsFlow worker ready; outbox dispatcher started\.') {
      Write-Host 'Worker readiness log observed.'
      return
    }

    $running = Invoke-NativeCommand -Description 'Worker state inspection' -FilePath 'docker' -ArgumentList @('inspect', '--format', '{{.State.Running}}', $workerContainer) -CaptureOutput
    if ($running -ne 'true') {
      $exitCode = Invoke-NativeCommand -Description 'Worker exit-code inspection' -FilePath 'docker' -ArgumentList @('inspect', '--format', '{{.State.ExitCode}}', $workerContainer) -CaptureOutput
      throw "Worker exited before readiness with exit code $exitCode. Logs:`n$logs"
    }

    Start-Sleep -Milliseconds 500
  }

  $finalLogs = Invoke-NativeCommand -Description 'Worker log inspection' -FilePath 'docker' -ArgumentList @('logs', $workerContainer) -CaptureOutput
  throw "Worker did not report readiness within $TimeoutSeconds seconds. Logs:`n$finalLogs"
}

function Invoke-GateCleanup {
  if ($script:cleanupStarted) {
    return
  }
  $script:cleanupStarted = $true

  Write-GateStep 'Cleaning up disposable gate resources'

  if ($script:workerContainerCreated) {
    Invoke-CleanupCommand -Description 'Remove disposable worker container' -FilePath 'docker' -ArgumentList @('rm', '--force', $workerContainer)
  }

  if ($script:composeLifecycleStarted) {
    Invoke-CleanupCommand -Description 'Remove disposable Compose project and volumes' -FilePath 'docker' -ArgumentList ($composeArguments + @('down', '--volumes', '--remove-orphans'))
  }

  if ($script:workerImageCreated) {
    Invoke-CleanupCommand -Description 'Remove disposable worker image' -FilePath 'docker' -ArgumentList @('image', 'rm', '--force', $workerImage)
  }

  if ($script:workerContextCreated -and (Test-Path -LiteralPath $workerContext)) {
    try {
      Remove-Item -LiteralPath $workerContext -Recurse -Force
    }
    catch {
      $script:cleanupErrors.Add("Remove temporary worker context failed: $($_.Exception.Message)")
    }
  }
}

try {
  Set-Location -LiteralPath $repoRoot

  Write-GateStep 'Checking prerequisites and repository inputs'
  foreach ($path in @($composeFile, $environmentFile, (Join-Path $repoRoot 'package-lock.json'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Required file is missing: $path"
    }
  }

  Invoke-NativeCommand -Description 'Docker client check' -FilePath 'docker' -ArgumentList @('--version')
  Invoke-NativeCommand -Description 'Docker Compose check' -FilePath 'docker' -ArgumentList @('compose', 'version')
  Invoke-NativeCommand -Description 'Docker daemon check' -FilePath 'docker' -ArgumentList @('info')

  Write-GateStep 'Checking npm.cmd through the native-command wrapper'
  Invoke-NativeCommand -Description 'npm.cmd preflight' -FilePath 'npm.cmd' -ArgumentList @('--version')

  $existingResources = @(Get-ProjectResourceIds)
  if ($existingResources.Count -gt 0) {
    throw "Disposable project name unexpectedly collides with existing resources: $($existingResources -join ', ')"
  }

  $postgresPort = Get-AvailableTcpPort
  do {
    $redisPort = Get-AvailableTcpPort
  } while ($redisPort -eq $postgresPort)

  $env:NODE_ENV = 'test'
  $env:POSTGRES_PASSWORD = 'opsflow_gate_local'
  $env:POSTGRES_PORT = "$postgresPort"
  $env:REDIS_PORT = "$redisPort"
  $env:DATABASE_URL = "postgresql://opsflow:opsflow_gate_local@127.0.0.1:$postgresPort/opsflow"
  $env:REDIS_URL = "redis://127.0.0.1:$redisPort"

  Write-Host "Disposable Compose project: $projectName"
  Write-Host "PostgreSQL host port: $postgresPort"
  Write-Host "Redis host port: $redisPort"

  Invoke-NativeCommand -Description 'Compose configuration validation' -FilePath 'docker' -ArgumentList ($composeArguments + @('config', '--quiet'))

  Write-GateStep 'Starting PostgreSQL and Redis and waiting for health checks'
  $composeLifecycleStarted = $true
  Invoke-NativeCommand -Description 'Compose startup' -FilePath 'docker' -ArgumentList ($composeArguments + @('up', '--detach', '--wait', '--wait-timeout', '120'))

  $postgresContainer = Invoke-NativeCommand -Description 'PostgreSQL container lookup' -FilePath 'docker' -ArgumentList ($composeArguments + @('ps', '--quiet', 'postgres')) -CaptureOutput
  $redisContainer = Invoke-NativeCommand -Description 'Redis container lookup' -FilePath 'docker' -ArgumentList ($composeArguments + @('ps', '--quiet', 'redis')) -CaptureOutput
  if (-not $postgresContainer -or -not $redisContainer) {
    throw 'Compose did not return both service container IDs.'
  }

  $postgresHealth = Invoke-NativeCommand -Description 'PostgreSQL health inspection' -FilePath 'docker' -ArgumentList @('inspect', '--format', '{{.State.Health.Status}}', $postgresContainer) -CaptureOutput
  $redisHealth = Invoke-NativeCommand -Description 'Redis health inspection' -FilePath 'docker' -ArgumentList @('inspect', '--format', '{{.State.Health.Status}}', $redisContainer) -CaptureOutput
  if ($postgresHealth -ne 'healthy' -or $redisHealth -ne 'healthy') {
    throw "Unexpected service health: PostgreSQL=$postgresHealth Redis=$redisHealth"
  }
  Write-Host 'PostgreSQL health: healthy'
  Write-Host 'Redis health: healthy'

  Invoke-NativeCommand -Description 'PostgreSQL readiness probe' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'postgres', 'pg_isready', '--username', 'opsflow', '--dbname', 'opsflow'))
  $redisPing = Invoke-NativeCommand -Description 'Redis PING' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'redis', 'redis-cli', 'PING')) -CaptureOutput
  if ($redisPing -ne 'PONG') {
    throw "Redis PING returned '$redisPing' instead of PONG."
  }
  Write-Host 'Redis PING: PONG'

  Write-GateStep 'Running the application service connectivity check'
  Invoke-NativeCommand -Description 'npm.cmd services:check' -FilePath 'npm.cmd' -ArgumentList @('run', 'services:check')

  Write-GateStep 'Applying committed migrations to the disposable database'
  Invoke-NativeCommand -Description 'npm.cmd db:migrate' -FilePath 'npm.cmd' -ArgumentList @('run', 'db:migrate')

  Write-GateStep 'Writing PostgreSQL and Redis persistence probes'
  $writeSql = "CREATE TABLE IF NOT EXISTS infrastructure_gate_probe (id integer PRIMARY KEY, marker text NOT NULL); INSERT INTO infrastructure_gate_probe (id, marker) VALUES (1, '$probeMarker') ON CONFLICT (id) DO UPDATE SET marker = EXCLUDED.marker;"
  Invoke-NativeCommand -Description 'PostgreSQL persistence probe write' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'postgres', 'psql', '--username', 'opsflow', '--dbname', 'opsflow', '--set', 'ON_ERROR_STOP=1', '--command', $writeSql))
  $redisSet = Invoke-NativeCommand -Description 'Redis persistence probe write' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'redis', 'redis-cli', 'SET', $redisProbeKey, $probeMarker)) -CaptureOutput
  if ($redisSet -ne 'OK') {
    throw "Redis SET returned '$redisSet' instead of OK."
  }
  $redisSave = Invoke-NativeCommand -Description 'Redis persistence flush' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'redis', 'redis-cli', 'SAVE')) -CaptureOutput
  if ($redisSave -ne 'OK') {
    throw "Redis SAVE returned '$redisSave' instead of OK."
  }

  Write-GateStep 'Recreating services without deleting their named volumes'
  Invoke-NativeCommand -Description 'Compose shutdown for persistence test' -FilePath 'docker' -ArgumentList ($composeArguments + @('down', '--remove-orphans'))
  Invoke-NativeCommand -Description 'Compose restart for persistence test' -FilePath 'docker' -ArgumentList ($composeArguments + @('up', '--detach', '--wait', '--wait-timeout', '120'))

  $postgresMarker = Invoke-NativeCommand -Description 'PostgreSQL persistence probe read' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'postgres', 'psql', '--username', 'opsflow', '--dbname', 'opsflow', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', 'SELECT marker FROM infrastructure_gate_probe WHERE id = 1;')) -CaptureOutput
  $redisMarker = Invoke-NativeCommand -Description 'Redis persistence probe read' -FilePath 'docker' -ArgumentList ($composeArguments + @('exec', '--no-TTY', 'redis', 'redis-cli', '--raw', 'GET', $redisProbeKey)) -CaptureOutput
  if ($postgresMarker -ne $probeMarker) {
    throw "PostgreSQL did not preserve the expected marker after service recreation. Expected '$probeMarker', received '$postgresMarker'."
  }
  if ($redisMarker -ne $probeMarker) {
    throw "Redis did not preserve the expected marker after service recreation. Expected '$probeMarker', received '$redisMarker'."
  }
  Write-Host "PostgreSQL persistence marker: $postgresMarker"
  Write-Host "Redis persistence marker: $redisMarker"

  Write-GateStep 'Rechecking application connectivity after service recreation'
  Invoke-NativeCommand -Description 'npm.cmd services:check after restart' -FilePath 'npm.cmd' -ArgumentList @('run', 'services:check')

  Write-GateStep 'Building a disposable Linux worker image'
  New-Item -ItemType Directory -Path $workerContext -Force | Out-Null
  $workerContextCreated = $true
  foreach ($relativePath in @(
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'apps/worker/package.json',
      'apps/worker/tsconfig.json',
      'packages/config/package.json',
      'packages/config/tsconfig.json',
      'packages/config/tsconfig.base.json',
      'packages/shared/package.json'
      'packages/shared/tsconfig.json'
    )) {
    Copy-GateFile -RelativePath $relativePath
  }
  Copy-Item -LiteralPath (Join-Path $repoRoot 'apps/worker/src') -Destination (Join-Path $workerContext 'apps/worker/src') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'packages/config/src') -Destination (Join-Path $workerContext 'packages/config/src') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'packages/shared/src') -Destination (Join-Path $workerContext 'packages/shared/src') -Recurse -Force

  $dockerfile = @'
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts
RUN npm run build -w @opsflow/shared && npm run build -w @opsflow/config && npm run build -w @opsflow/worker
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
'@
  $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText((Join-Path $workerContext 'Dockerfile'), $dockerfile, $utf8WithoutBom)

  Invoke-NativeCommand -Description 'Disposable worker image build' -FilePath 'docker' -ArgumentList @('build', '--label', "com.opsflow.infrastructure-gate=$projectName", '--tag', $workerImage, $workerContext)
  $workerImageCreated = $true

  $networkName = Invoke-NativeCommand -Description 'Compose network lookup' -FilePath 'docker' -ArgumentList @('network', 'ls', '--quiet', '--filter', "label=com.docker.compose.project=$projectName", '--filter', 'label=com.docker.compose.network=default') -CaptureOutput
  if (-not $networkName -or $networkName -match "`r?`n") {
    throw "Expected one Compose default network, received '$networkName'."
  }

  Write-GateStep 'Starting the worker and waiting for readiness'
  $workerId = Invoke-NativeCommand -Description 'Disposable worker startup' -FilePath 'docker' -ArgumentList @(
    'run',
    '--detach',
    '--name',
    $workerContainer,
    '--label',
    "com.opsflow.infrastructure-gate=$projectName",
    '--network',
    $networkName,
    '--env',
    'NODE_ENV=test',
    '--env',
    'DATABASE_URL=postgresql://opsflow:opsflow_gate_local@postgres:5432/opsflow',
    '--env',
    'REDIS_URL=redis://redis:6379',
    $workerImage
  ) -CaptureOutput
  if (-not $workerId) {
    throw 'Docker did not return an ID for the disposable worker container.'
  }
  $workerContainerCreated = $true
  Wait-ForWorkerReadiness -TimeoutSeconds 30

  Write-GateStep 'Sending SIGTERM and verifying graceful worker shutdown'
  Invoke-NativeCommand -Description 'Graceful worker stop' -FilePath 'docker' -ArgumentList @('stop', '--signal', 'SIGTERM', '--timeout', '10', $workerContainer)
  $workerExitCode = Invoke-NativeCommand -Description 'Worker exit-code inspection' -FilePath 'docker' -ArgumentList @('inspect', '--format', '{{.State.ExitCode}}', $workerContainer) -CaptureOutput
  if ($workerExitCode -ne '0') {
    $workerLogs = Invoke-NativeCommand -Description 'Worker log inspection' -FilePath 'docker' -ArgumentList @('logs', $workerContainer) -CaptureOutput
    throw "Worker did not exit cleanly after SIGTERM. Exit code: $workerExitCode. Logs:`n$workerLogs"
  }
  Write-Host 'Worker SIGTERM exit code: 0'
}
catch {
  $primaryFailure = $_
  [Console]::Error.WriteLine('Gate failure captured before cleanup:')
  [Console]::Error.WriteLine($primaryFailure.Exception.Message)

  $failurePosition = $primaryFailure.InvocationInfo.PositionMessage
  if ($failurePosition) {
    [Console]::Error.WriteLine('Failure position:')
    [Console]::Error.WriteLine($failurePosition)
  }

  $failureStackTrace = $primaryFailure.ScriptStackTrace
  if ($failureStackTrace) {
    [Console]::Error.WriteLine('Script stack trace:')
    [Console]::Error.WriteLine($failureStackTrace)
  }
}
finally {
  try {
    Invoke-GateCleanup
  }
  catch {
    $cleanupErrors.Add("Unexpected cleanup failure: $($_.Exception.Message)")
  }

  try {
    foreach ($name in $environmentNames) {
      $originalValue = $originalEnvironment[$name]
      if ($null -eq $originalValue) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
      }
      else {
        Set-Item -LiteralPath "Env:$name" -Value $originalValue
      }
    }
  }
  catch {
    $cleanupErrors.Add("Environment restoration failed: $($_.Exception.Message)")
  }

  try {
    Set-Location -LiteralPath $originalLocation
  }
  catch {
    $cleanupErrors.Add("Working-directory restoration failed: $($_.Exception.Message)")
  }
}

if ($null -ne $primaryFailure) {
  [Console]::Error.WriteLine("PHASE 3 MILESTONE 1 INFRASTRUCTURE GATE: FAILED")
  [Console]::Error.WriteLine($primaryFailure.Exception.Message)
  if ($cleanupErrors.Count -gt 0) {
    [Console]::Error.WriteLine("Cleanup also reported: $($cleanupErrors -join ' | ')")
  }
  exit 1
}

if ($cleanupErrors.Count -gt 0) {
  [Console]::Error.WriteLine('PHASE 3 MILESTONE 1 INFRASTRUCTURE GATE: FAILED DURING CLEANUP')
  [Console]::Error.WriteLine($cleanupErrors -join ' | ')
  exit 1
}

Write-Host "`nPHASE 3 MILESTONE 1 INFRASTRUCTURE GATE: PASSED" -ForegroundColor Green
Write-Host "Verified disposable project $projectName and removed its containers, network, volumes, worker image, and temporary build context."
