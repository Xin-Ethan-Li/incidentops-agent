#requires -Version 7.0
[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$DryRun,
  [string]$Region,
  [string]$Cluster,
  [string]$TaskDefinition,
  [string[]]$SubnetIds,
  [string]$SecurityGroupId,
  [string]$IncidentId,
  [string]$ClientToken,
  [string]$AssignPublicIp,
  [int]$ObservationTimeoutSeconds = 600,
  [int]$PollIntervalMilliseconds = 1000,
  [int]$LogDeliveryTimeoutSeconds = 30,
  [int]$StopObservationTimeoutSeconds = 45,
  [string]$AwsExecutable = 'aws'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:launchSubmitted = $false
$script:temporaryCleanupFailed = $false
$knownTask = $null
$taskStopped = $false
$canonicalDefinition = $null
$exitCode = 1
$result = [ordered]@{
  status = 'FAILED'; category = $null; taskArn = $null; clientToken = $null
  taskStatus = $null; containerStatus = $null; containerExitCode = $null
  stoppedReason = $null; logStream = $null; taskStarted = $false
  containerExitedSuccessfully = $false; investigationCompleted = $false
  verificationReady = $false; mcpEvidenceVerified = $false; diagnosisStructureValid = $false
  humanDiagnosisQuality = 'PENDING'; diagnosis = $null; toolExecutions = @()
  operatorCleanup = @{ stopRequested = $false; stoppedObserved = $false; stopRequestFailed = $false }
}

function Fail([string]$Code) { throw [InvalidOperationException]::new($Code) }
function Require([bool]$Condition, [string]$Code) { if (-not $Condition) { Fail $Code } }
function IsMap($Value) { return $Value -is [System.Collections.IDictionary] }
function Nonempty($Value) { return $Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value) }

function Invoke-Aws([string]$Service, [string]$Operation, [hashtable]$InputData, [switch]$AllowMissing) {
  # File input avoids native Windows JSON argument quoting. It contains no secret values.
  $requestFile = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($requestFile, ($InputData | ConvertTo-Json -Depth 40 -Compress), [Text.UTF8Encoding]::new($false))
    $arguments = @($Service, $Operation, '--cli-input-json', ('file://' + $requestFile),
      '--region', $Region, '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt',
      '--cli-connect-timeout', '5', '--cli-read-timeout', '5')
    $global:LASTEXITCODE = 0
    $raw = (@(& $AwsExecutable @arguments 2>&1) | ForEach-Object { $_.ToString() }) -join "`n"
    if ($LASTEXITCODE -ne 0) {
      if ($AllowMissing -and $raw.Contains('ResourceNotFoundException')) { return $null }
      Fail 'AWS_CLI_FAILED'
    }
    try { $parsed = ConvertFrom-Json -InputObject $raw -AsHashtable -Depth 100 }
    catch { Fail 'AWS_RESPONSE_INVALID' }
    Require (IsMap $parsed) 'AWS_RESPONSE_INVALID'
    return $parsed
  } finally {
    try { Remove-Item -LiteralPath $requestFile -Force -ErrorAction Stop }
    catch { $script:temporaryCleanupFailed = $true }
  }
}

function Assert-TaskIdentity($Task, [string]$DefinitionArn) {
  Require (IsMap $Task) 'TASK_IDENTITY_MISMATCH'
  Require ($Task['clusterArn'] -ceq $Cluster -and $Task['taskDefinitionArn'] -ceq $DefinitionArn) 'TASK_IDENTITY_MISMATCH'
  $arnPrefix = $Cluster.Substring(0, $Cluster.IndexOf(':cluster/')) + ':task/'
  Require ((Nonempty $Task['taskArn']) -and $Task['taskArn'].StartsWith($arnPrefix) -and
    $Task['taskArn'] -match '^arn:[a-z-]+:ecs:[a-z0-9-]+:[0-9]{12}:task/[A-Za-z0-9/_-]+$') 'TASK_IDENTITY_MISMATCH'
}

function Get-OneTask([string]$TaskArn, [string]$DefinitionArn) {
  $response = Invoke-Aws 'ecs' 'describe-tasks' @{ cluster = $Cluster; tasks = @($TaskArn) }
  if (@($response['tasks']).Count -eq 0 -or $null -eq $response['tasks']) {
    foreach ($failure in @($response['failures'])) {
      if ($null -ne $failure) { Require ($failure['reason'] -ceq 'MISSING') 'TASK_OBSERVATION_FAILED' }
    }
    return $null # Eventual consistency, never completion.
  }
  Require (@($response['failures']).Count -eq 0 -or $null -eq $response['failures']) 'TASK_OBSERVATION_FAILED'
  Require (@($response['tasks']).Count -eq 1) 'TASK_IDENTITY_MISMATCH'
  $task = $response['tasks'][0]
  Assert-TaskIdentity $task $DefinitionArn
  Require ($task['taskArn'] -ceq $TaskArn) 'TASK_IDENTITY_MISMATCH'
  return $task
}

function Record-Task($Task) {
  $result.taskStatus = $Task['lastStatus']
  if ($Task['lastStatus'] -ceq 'RUNNING' -or $null -ne $Task['startedAt']) { $result.taskStarted = $true }
  $reason = $Task['stoppedReason']
  # Unknown AWS messages are not printed: they can contain arbitrary application text.
  $result.stoppedReason = if ($reason -in @('Essential container in task exited', 'User initiated')) { $reason }
    elseif ($null -eq $reason) { $null } else { 'OTHER_REDACTED' }
  $containers = @($Task['containers'])
  if ($containers.Count -eq 1 -and $null -ne $containers[0] -and $containers[0]['name'] -ceq 'incidentops-agent') {
    $result.containerStatus = $containers[0]['lastStatus']
    $result.containerExitCode = $containers[0]['exitCode']
    $result.containerExitedSuccessfully = $containers[0]['lastStatus'] -ceq 'STOPPED' -and
      ($containers[0]['exitCode'] -is [int] -or $containers[0]['exitCode'] -is [long]) -and $containers[0]['exitCode'] -eq 0
  }
}

function Get-Report([string]$Group, [string]$Stream) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt $LogDeliveryTimeoutSeconds) {
    $messages = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new()
    $token = $null
    $complete = $false
    $length = 0
    for ($page = 0; $page -lt 100 -and $watch.Elapsed.TotalSeconds -lt $LogDeliveryTimeoutSeconds; $page++) {
      $inputData = @{ logGroupName = $Group; logStreamName = $Stream; startFromHead = $true }
      if ($null -ne $token) { $inputData.nextToken = $token }
      $response = Invoke-Aws 'logs' 'get-log-events' $inputData -AllowMissing
      if ($null -eq $response) { break }
      Require ((Nonempty $response['nextForwardToken']) -and $response['events'] -is [array]) 'LOGS_INCOMPLETE'
      foreach ($event in $response['events']) {
        Require ((IsMap $event) -and $event['message'] -is [string]) 'LOGS_INCOMPLETE'
        $length += $event['message'].Length
        Require ($length -le 1048576) 'LOGS_INCOMPLETE'
        $messages.Add($event['message'])
      }
      $next = $response['nextForwardToken']
      if ($null -ne $token -and $next -ceq $token) { $complete = $true; break }
      Require ($seen.Add($next)) 'LOGS_INCOMPLETE'
      $token = $next
    }
    if ($complete -and $messages.Count -gt 0) {
      try {
        $report = ConvertFrom-Json -InputObject ($messages -join "`n") -AsHashtable -Depth 100
        if (IsMap $report) { return $report }
      } catch { } # Delayed/truncated JSON is never a successful result; retry only log reads.
    }
    Start-Sleep -Milliseconds $PollIntervalMilliseconds
  }
  Fail 'LOGS_INCOMPLETE'
}

function Assert-Report($Report) {
  Require ($Report['execution'] -ceq 'OPENAI_ADAPTER' -and $Report['incidentId'] -ceq $IncidentId) 'REPORT_INVALID'
  Require (-not $Report.Contains('inspection') -and $Report['humanDiagnosisReview'] -ceq 'PENDING') 'REPORT_INVALID'
  Require ((IsMap $Report['outcome']) -and $Report['outcome']['status'] -ceq 'COMPLETED') 'INVESTIGATION_NOT_COMPLETED'
  $result.investigationCompleted = $true
  Require ($Report['verificationReady'] -is [bool] -and $Report['verificationReady']) 'VERIFICATION_NOT_READY'
  $diagnosis = $Report['outcome']['diagnosis']
  $fields = @('summary', 'probableCause', 'confidence', 'evidence', 'recommendedActions')
  Require ((IsMap $diagnosis) -and $diagnosis.Count -eq 5) 'DIAGNOSIS_INVALID'
  foreach ($field in $fields) { Require ($diagnosis.Contains($field)) 'DIAGNOSIS_INVALID' }
  Require ((Nonempty $diagnosis['summary']) -and (Nonempty $diagnosis['probableCause']) -and
    $diagnosis['confidence'] -cin @('low', 'medium', 'high')) 'DIAGNOSIS_INVALID'
  foreach ($field in @('evidence', 'recommendedActions')) {
    Require ($diagnosis[$field] -is [array]) 'DIAGNOSIS_INVALID'
    foreach ($text in $diagnosis[$field]) { Require (Nonempty $text) 'DIAGNOSIS_INVALID' }
  }
  $result.diagnosisStructureValid = $true
  $cleanup = $Report['cleanup']
  Require ((IsMap $cleanup) -and $cleanup['mcpClose'] -ceq 'SUCCEEDED' -and $cleanup['childExit'] -ceq 'OBSERVED' -and
    $cleanup['tracingShutdown'] -ceq 'SUCCEEDED' -and $cleanup['errors'] -is [array] -and $cleanup['errors'].Count -eq 0) 'REPORT_CLEANUP_INCOMPLETE'
  Require ($Report['traceComplete'] -is [bool] -and $Report['traceComplete']) 'REPORT_INVALID'
  Require ((IsMap $Report['observed']) -and $Report['observed']['requestedTools'] -is [array] -and
    $Report['observed']['deliveredCallIds'] -is [array] -and $Report['outcome']['toolExecutions'] -is [array]) 'MCP_EVIDENCE_MISSING'
  $requests = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
  foreach ($request in $Report['observed']['requestedTools']) {
    Require ((IsMap $request) -and (Nonempty $request['callId']) -and
      $request['toolName'] -cin @('search_logs', 'get_metrics', 'get_service_info', 'search_runbook') -and
      -not $requests.ContainsKey($request['callId'])) 'MCP_EVIDENCE_MISSING'
    $requests[$request['callId']] = $request['toolName']
  }
  $evidence = $false
  $executions = @()
  foreach ($execution in $Report['outcome']['toolExecutions']) {
    Require ((IsMap $execution) -and (Nonempty $execution['callId']) -and
      $requests.ContainsKey($execution['callId']) -and $requests[$execution['callId']] -ceq $execution['toolName'] -and
      $execution['status'] -cin @('FAILED', 'SUCCEEDED')) 'MCP_EVIDENCE_MISSING'
    if ($execution['status'] -ceq 'SUCCEEDED' -and $Report['observed']['deliveredCallIds'] -ccontains $execution['callId']) { $evidence = $true }
    $executions += @{ callId = $execution['callId']; toolName = $execution['toolName']; status = $execution['status'] }
  }
  Require $evidence 'MCP_EVIDENCE_MISSING'
  $result.mcpEvidenceVerified = $true
  $result.verificationReady = $true
  $result.diagnosis = $diagnosis
  $result.toolExecutions = $executions
}

try {
  Require (-not ($Execute -and $DryRun)) 'INVALID_CONFIGURATION'
  Require ($Region -cmatch '^[a-z]{2}(?:-[a-z]+)+-[0-9]+$') 'INVALID_CONFIGURATION'
  Require ($Cluster -cmatch '^arn:(aws|aws-cn|aws-us-gov):ecs:([a-z0-9-]+):([0-9]{12}):cluster/([A-Za-z0-9_-]+)$') 'INVALID_CONFIGURATION'
  $partition = $Matches[1]; $clusterRegion = $Matches[2]; $account = $Matches[3]
  Require ($clusterRegion -ceq $Region) 'INVALID_CONFIGURATION'
  $ecsPrefix = "arn:${partition}:ecs:${Region}:${account}:"
  Require ($TaskDefinition -cmatch '^(?:arn:(?:aws|aws-cn|aws-us-gov):ecs:[a-z0-9-]+:[0-9]{12}:task-definition/)?[A-Za-z0-9_-]+:[1-9][0-9]*$') 'INVALID_CONFIGURATION'
  if ($TaskDefinition.StartsWith('arn:')) { Require ($TaskDefinition.StartsWith($ecsPrefix + 'task-definition/')) 'INVALID_CONFIGURATION' }
  Require ($null -ne $SubnetIds -and $SubnetIds.Count -ge 1 -and $SubnetIds.Count -le 16 -and @($SubnetIds | Select-Object -Unique).Count -eq $SubnetIds.Count) 'INVALID_CONFIGURATION'
  foreach ($subnet in $SubnetIds) { Require ($subnet -cmatch '^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$') 'INVALID_CONFIGURATION' }
  Require ($SecurityGroupId -cmatch '^sg-(?:[0-9a-f]{8}|[0-9a-f]{17})$') 'INVALID_CONFIGURATION'
  Require ($AssignPublicIp -cin @('ENABLED', 'DISABLED')) 'INVALID_CONFIGURATION'
  Require ($IncidentId -cmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' -and $ClientToken -cmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') 'INVALID_CONFIGURATION'
  Require ($ObservationTimeoutSeconds -ge 1 -and $ObservationTimeoutSeconds -le 600 -and
    $PollIntervalMilliseconds -ge 1 -and $PollIntervalMilliseconds -le 5000 -and
    $LogDeliveryTimeoutSeconds -ge 1 -and $LogDeliveryTimeoutSeconds -le 60 -and
    $StopObservationTimeoutSeconds -ge 1 -and $StopObservationTimeoutSeconds -le 120) 'INVALID_CONFIGURATION'
  $result.clientToken = $ClientToken
  $request = @{ cluster = $Cluster; taskDefinition = $TaskDefinition; count = 1; launchType = 'FARGATE';
    clientToken = $ClientToken; platformVersion = '1.4.0'; enableExecuteCommand = $false;
    networkConfiguration = @{ awsvpcConfiguration = @{ subnets = @($SubnetIds); securityGroups = @($SecurityGroupId); assignPublicIp = $AssignPublicIp } };
    overrides = @{ containerOverrides = @(@{ name = 'incidentops-agent'; command = @('dist/run-investigation.js', '--live', '--incident', $IncidentId) }) } }
  if (-not $Execute) {
    $result.status = 'PLAN_ONLY'; $result.category = 'NO_AWS_CALLS'; $result['request'] = $request
    $exitCode = 0
  } else {
    $previousAttempts = $env:AWS_MAX_ATTEMPTS
    $env:AWS_MAX_ATTEMPTS = '1' # No hidden SDK retry of RunTask; token is caller supplied.
    try {
      $response = Invoke-Aws 'ecs' 'describe-task-definition' @{ taskDefinition = $TaskDefinition }
      $definition = $response['taskDefinition']
      Require (IsMap $definition) 'TASK_DEFINITION_UNSAFE'
      $canonicalDefinition = $definition['taskDefinitionArn']
      Require ((Nonempty $canonicalDefinition) -and $canonicalDefinition.StartsWith($ecsPrefix + 'task-definition/')) 'TASK_DEFINITION_UNSAFE'
      $requestedRevision = ($TaskDefinition -split '/')[-1]
      Require (($canonicalDefinition -split '/')[-1] -ceq $requestedRevision) 'TASK_DEFINITION_UNSAFE'
      Require ($definition['networkMode'] -ceq 'awsvpc' -and $definition['cpu'] -eq '256' -and $definition['memory'] -eq '1024' -and
        @($definition['requiresCompatibilities']) -ccontains 'FARGATE' -and (IsMap $definition['runtimePlatform']) -and
        $definition['runtimePlatform']['cpuArchitecture'] -ceq 'X86_64' -and $definition['runtimePlatform']['operatingSystemFamily'] -ceq 'LINUX' -and
        [string]::IsNullOrEmpty($definition['taskRoleArn'])) 'TASK_DEFINITION_UNSAFE'
      Require (@($definition['containerDefinitions']).Count -eq 1) 'TASK_DEFINITION_UNSAFE'
      $container = $definition['containerDefinitions'][0]
      Require ($container['name'] -ceq 'incidentops-agent' -and $container['user'] -ceq '1000' -and
        (IsMap $container['linuxParameters']) -and $container['linuxParameters']['initProcessEnabled'] -eq $true -and
        $container['stopTimeout'] -eq 30 -and $container['image'] -cmatch '@sha256:[a-f0-9]{64}$') 'TASK_DEFINITION_UNSAFE'
      if ($container.Contains('entryPoint')) {
        $entryPoint = @($container['entryPoint'])

        Require (
            $entryPoint.Count -eq 0 -or
            (
                $entryPoint.Count -eq 1 -and
                $entryPoint[0] -ceq 'node'
            )
        ) 'TASK_DEFINITION_UNSAFE'
      }
      $keySecret = @($container['secrets'] | Where-Object { $_['name'] -ceq 'OPENAI_API_KEY' })
      Require ($keySecret.Count -eq 1 -and $keySecret[0]['valueFrom'].StartsWith("arn:${partition}:ssm:${Region}:${account}:parameter/")) 'TASK_DEFINITION_UNSAFE'
      $modelPresent = $false
      foreach ($item in @($container['environment'])) {
        Require ($item['name'] -cnotin @('OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'NODE_OPTIONS', 'OPENAI_BASE_URL')) 'TASK_DEFINITION_UNSAFE'
        if ($item['name'] -ceq 'OPENAI_AGENT_MODEL' -and (Nonempty $item['value'])) { $modelPresent = $true }
      }
      Require $modelPresent 'TASK_DEFINITION_UNSAFE'
      $logs = $container['logConfiguration']
      Require ((IsMap $logs) -and $logs['logDriver'] -ceq 'awslogs' -and (IsMap $logs['options'])) 'TASK_DEFINITION_UNSAFE'
      $logOptions = $logs['options']; $logGroup = $logOptions['awslogs-group']; $streamPrefix = $logOptions['awslogs-stream-prefix']
      Require ($logOptions['awslogs-region'] -ceq $Region -and $logGroup -cmatch '^[A-Za-z0-9_./#-]{1,512}$' -and
        $streamPrefix -cmatch '^[A-Za-z0-9_/-]{1,128}$') 'TASK_DEFINITION_UNSAFE'
      $request.taskDefinition = $canonicalDefinition
      Require (-not $script:launchSubmitted) 'DUPLICATE_LAUNCH_BLOCKED'
      $script:launchSubmitted = $true
      $watch = [Diagnostics.Stopwatch]::StartNew()
      try { $launch = Invoke-Aws 'ecs' 'run-task' $request }
      catch { Fail 'RECONCILIATION_REQUIRED' }
      Require (($null -eq $launch['failures'] -or @($launch['failures']).Count -eq 0) -and @($launch['tasks']).Count -eq 1) 'RECONCILIATION_REQUIRED'
      try { Assert-TaskIdentity $launch['tasks'][0] $canonicalDefinition }
      catch { Fail 'RECONCILIATION_REQUIRED' }
      $knownTask = $launch['tasks'][0]['taskArn']; $result.taskArn = $knownTask
      while ($watch.Elapsed.TotalSeconds -lt $ObservationTimeoutSeconds) {
        $task = Get-OneTask $knownTask $canonicalDefinition
        if ($null -ne $task) {
          Record-Task $task
          if ($task['lastStatus'] -ceq 'STOPPED') { $taskStopped = $true; break }
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
      }
      Require $taskStopped 'OBSERVATION_DEADLINE'
      $result.operatorCleanup.stoppedObserved = $true
      Require $result.containerExitedSuccessfully 'CONTAINER_EXIT_UNSUCCESSFUL'
      $taskId = ($knownTask -split '/')[-1]
      $result.logStream = $streamPrefix + '/incidentops-agent/' + $taskId
      $report = Get-Report $logGroup $result.logStream
      Assert-Report $report
      Require (-not $script:temporaryCleanupFailed) 'LOCAL_CLEANUP_INCOMPLETE'
      $result.status = 'SUCCEEDED'; $result.category = 'EXECUTION_VERIFIED_HUMAN_REVIEW_PENDING'; $exitCode = 0
    } finally {
      if ($null -ne $knownTask -and -not $taskStopped) {
        $result.operatorCleanup.stopRequested = $true
        try { $null = Invoke-Aws 'ecs' 'stop-task' @{ cluster = $Cluster; task = $knownTask; reason = 'IncidentOps operator observation ended' } }
        catch { $result.operatorCleanup.stopRequestFailed = $true }
        $stopWatch = [Diagnostics.Stopwatch]::StartNew()
        while ($stopWatch.Elapsed.TotalSeconds -lt $StopObservationTimeoutSeconds) {
          try {
            $last = Get-OneTask $knownTask $canonicalDefinition
            if ($null -ne $last) {
              Record-Task $last
              if ($last['lastStatus'] -ceq 'STOPPED') { $result.operatorCleanup.stoppedObserved = $true; break }
            }
          } catch { } # Preserve the primary failure, explicitly expose unobserved cleanup.
          Start-Sleep -Milliseconds $PollIntervalMilliseconds
        }
      }
      if ($null -eq $previousAttempts) { Remove-Item Env:AWS_MAX_ATTEMPTS -ErrorAction SilentlyContinue }
      else { $env:AWS_MAX_ATTEMPTS = $previousAttempts }
    }
  }
} catch {
  $allowed = @('INVALID_CONFIGURATION', 'AWS_CLI_FAILED', 'AWS_RESPONSE_INVALID', 'TASK_IDENTITY_MISMATCH',
    'TASK_OBSERVATION_FAILED', 'TASK_DEFINITION_UNSAFE', 'RECONCILIATION_REQUIRED', 'DUPLICATE_LAUNCH_BLOCKED',
    'OBSERVATION_DEADLINE', 'CONTAINER_EXIT_UNSUCCESSFUL', 'LOGS_INCOMPLETE', 'REPORT_INVALID',
    'INVESTIGATION_NOT_COMPLETED', 'VERIFICATION_NOT_READY', 'DIAGNOSIS_INVALID', 'REPORT_CLEANUP_INCOMPLETE',
    'MCP_EVIDENCE_MISSING', 'LOCAL_CLEANUP_INCOMPLETE')
  $result.category = if ($_.Exception.Message -in $allowed) { $_.Exception.Message } else { 'LOCAL_EXECUTION_ERROR' }
  if ($result.category -eq 'INVALID_CONFIGURATION') { $exitCode = 2 }
}

$result | ConvertTo-Json -Depth 20
exit $exitCode
