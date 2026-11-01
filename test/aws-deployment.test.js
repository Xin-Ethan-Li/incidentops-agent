import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const template = JSON.parse(readFileSync(new URL('../deploy/aws/fargate.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../deploy/aws/run-once.ps1', import.meta.url));
const resources = template.Resources;
const task = resources.TaskDefinition.Properties;
const container = task.ContainerDefinitions[0];
const ref = name => ({ Ref: name });
const parameters = { EnableTaskDefinition: 'true', ImageDigest: 'sha256:' + 'a'.repeat(64),
  OpenAIKeyParameterArn: 'arn:aws:ssm:us-east-1:111122223333:parameter/incidentops/openai', OpenAIModel: 'synthetic-test-model',
  CustomerManagedKmsKeyArn: '' };

// Evaluate only the boolean functions actually used here; this is not AWS validation.
function condition(expression, values) {
  if (expression.Ref) return values[expression.Ref];
  if (expression.Condition) return condition(template.Conditions[expression.Condition], values);
  if (expression['Fn::Equals']) return expression['Fn::Equals'].map(x => typeof x === 'object' ? condition(x, values) : x)
    .reduce((left, right) => left === right);
  if (expression['Fn::Not']) return !condition(expression['Fn::Not'][0], values);
  if (expression['Fn::And']) return expression['Fn::And'].every(x => condition(x, values));
  assert.fail('Unexpected template condition');
}

test('AWS template has exactly the standalone resource inventory and supplied existing VPC', () => {
  assert.equal(template.AWSTemplateFormatVersion, '2010-09-09');
  assert.deepEqual(Object.values(resources).map(x => x.Type).sort(), [
    'AWS::EC2::SecurityGroup', 'AWS::ECR::Repository', 'AWS::ECS::Cluster',
    'AWS::ECS::TaskDefinition', 'AWS::IAM::Role', 'AWS::Logs::LogGroup',
  ]);
  assert.equal(template.Parameters.VpcId.Type, 'AWS::EC2::VPC::Id');
  assert.ok(!Object.hasOwn(template.Parameters.VpcId, 'Default'));
  assert.equal(resources.Repository.Properties.ImageTagMutability, 'IMMUTABLE');
  assert.deepEqual(resources.Repository.Properties.EncryptionConfiguration, { EncryptionType: 'AES256' });
  assert.equal(resources.LogGroup.Properties.RetentionInDays, 7);
  assert.deepEqual(resources.SecurityGroup.Properties.VpcId, ref('VpcId'));
  assert.deepEqual(resources.SecurityGroup.Properties.SecurityGroupIngress, []);
  assert.deepEqual(resources.SecurityGroup.Properties.SecurityGroupEgress.map(x => [x.IpProtocol, x.FromPort, x.ToPort, x.CidrIp]),
    [['tcp', 443, 443, '0.0.0.0/0']]);
});

test('AWS two-phase condition and Rules reject partial activation rather than using placeholder secrets/digests', () => {
  assert.equal(template.Parameters.EnableTaskDefinition.Default, 'false');
  const rule = template.Rules.CompleteActivationInputs;
  assert.equal(condition(rule.RuleCondition, parameters), true);
  assert.equal(condition(rule.Assertions[0].Assert, parameters), true);
  assert.equal(condition(template.Conditions.TaskEnabled, parameters), true);
  for (const name of ['ImageDigest', 'OpenAIKeyParameterArn', 'OpenAIModel']) {
    const incomplete = { ...parameters, [name]: '' };
    assert.equal(condition(rule.Assertions[0].Assert, incomplete), false, name);
    assert.equal(condition(template.Conditions.TaskEnabled, incomplete), false, name);
  }
  assert.equal(condition(template.Conditions.TaskEnabled, { ...parameters, EnableTaskDefinition: 'false' }), false);
  assert.equal(resources.TaskDefinition.Condition, 'TaskEnabled');
  assert.equal(template.Outputs.TaskDefinitionArn.Condition, 'TaskEnabled');
  assert.ok(new RegExp(template.Parameters.ImageDigest.AllowedPattern).test(parameters.ImageDigest));
  assert.ok(!new RegExp(template.Parameters.ImageDigest.AllowedPattern).test('latest'));
});

test('AWS runtime preserves the Node image, non-root CLI and Fargate process lifecycle', () => {
  assert.deepEqual(task.RequiresCompatibilities, ['FARGATE']);
  assert.equal(task.NetworkMode, 'awsvpc');
  assert.equal(task.Cpu, '256'); assert.equal(task.Memory, '1024');
  assert.deepEqual(task.RuntimePlatform, { OperatingSystemFamily: 'LINUX', CpuArchitecture: 'X86_64' });
  assert.equal(container.Name, 'incidentops-agent'); assert.equal(container.User, '1000');
  assert.equal(container.LinuxParameters.InitProcessEnabled, true); assert.equal(container.StopTimeout, 30);
  assert.ok(!Object.hasOwn(container, 'EntryPoint'));
  assert.deepEqual(container.Command, ['dist/run-investigation.js']);
  assert.ok(!Object.hasOwn(container, 'PortMappings'));
  assert.ok(!Object.hasOwn(container, 'HealthCheck'));
  assert.deepEqual(container.Image, { 'Fn::Sub': '${Repository.RepositoryUri}@${ImageDigest}' });
  assert.match(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'), /ENTRYPOINT \["node"\]/);
});

test('AWS secrets and execution role are narrow; no application task role or plaintext API key', () => {
  assert.ok(!Object.hasOwn(task, 'TaskRoleArn'));
  assert.deepEqual(container.Secrets, [{ Name: 'OPENAI_API_KEY', ValueFrom: ref('OpenAIKeyParameterArn') }]);
  assert.deepEqual(container.Environment, [{ Name: 'OPENAI_AGENT_MODEL', Value: ref('OpenAIModel') }]);
  const policies = resources.ExecutionRole.Properties.Policies;
  const statements = policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements.filter(x => x.Resource === '*').map(x => x.Action), [['ecr:GetAuthorizationToken']]);
  assert.deepEqual(statements[1].Resource, { 'Fn::GetAtt': ['Repository', 'Arn'] });
  assert.deepEqual(statements[2].Action, ['logs:CreateLogStream', 'logs:PutLogEvents']);
  assert.match(statements[2].Resource['Fn::Sub'], /:log-group:\$\{LogGroup\}:log-stream:\*$/);
  assert.equal(policies[1]['Fn::If'][0], 'TaskEnabled');
  assert.deepEqual(policies[1]['Fn::If'][1].PolicyDocument.Statement,
    [{ Effect: 'Allow', Action: ['ssm:GetParameters'], Resource: ref('OpenAIKeyParameterArn') }]);
  assert.equal(policies[2]['Fn::If'][0], 'UseCustomerManagedKey');
  assert.deepEqual(policies[2]['Fn::If'][1].PolicyDocument.Statement,
    [{ Effect: 'Allow', Action: ['kms:Decrypt'], Resource: ref('CustomerManagedKmsKeyArn') }]);
  assert.equal(condition(template.Conditions.UseCustomerManagedKey, parameters), false);
  assert.equal(condition(template.Conditions.UseCustomerManagedKey, { ...parameters, CustomerManagedKmsKeyArn: 'synthetic-key-arn' }), true);
  assert.doesNotMatch(JSON.stringify(template), /AdministratorAccess|AWS::SSM::Parameter|ssm:\*|kms:\*/);
});

test('AWS logging names the owned stream and never enables a public investigation service', () => {
  assert.equal(container.LogConfiguration.LogDriver, 'awslogs');
  assert.deepEqual(container.LogConfiguration.Options['awslogs-group'], ref('LogGroup'));
  assert.deepEqual(container.LogConfiguration.Options['awslogs-region'], ref('AWS::Region'));
  assert.equal(container.LogConfiguration.Options['awslogs-stream-prefix'], 'investigation');
  assert.equal(container.LogConfiguration.Options.mode, 'blocking');
  assert.doesNotMatch(JSON.stringify(template), /AWS::ECS::Service|AWS::ElasticLoadBalancing|AWS::Lambda|AWS::EC2::NatGateway|AWS::EC2::VPCEndpoint/);
});

const pwsh = [process.env.INCIDENTOPS_PWSH, 'pwsh'].filter(Boolean).find(candidate => {
  const result = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000 });
  return result.status === 0 && Number(result.stdout.trim()) >= 7;
});
const cluster = 'arn:aws:ecs:us-east-1:111122223333:cluster/incidentops-agent';
const definitionArn = 'arn:aws:ecs:us-east-1:111122223333:task-definition/incidentops-agent:7';
const taskArn = 'arn:aws:ecs:us-east-1:111122223333:task/incidentops-agent/' + 'a'.repeat(32);
const definition = { taskDefinitionArn: definitionArn, requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '1024', networkMode: 'awsvpc',
  runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' }, containerDefinitions: [{
    name: 'incidentops-agent', user: '1000', linuxParameters: { initProcessEnabled: true }, stopTimeout: 30,
    image: '111122223333.dkr.ecr.us-east-1.amazonaws.com/incidentops-agent@' + parameters.ImageDigest,
    secrets: [{ name: 'OPENAI_API_KEY', valueFrom: parameters.OpenAIKeyParameterArn }],
    environment: [{ name: 'OPENAI_AGENT_MODEL', value: 'synthetic-test-model' }],
    logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-region': 'us-east-1', 'awslogs-group': '/ecs/incidentops-agent/investigation', 'awslogs-stream-prefix': 'investigation' } },
  }] };
const stopped = { taskArn, clusterArn: cluster, taskDefinitionArn: definitionArn, lastStatus: 'STOPPED', startedAt: 'synthetic-start',
  stoppedReason: 'Essential container in task exited', containers: [{ name: 'incidentops-agent', lastStatus: 'STOPPED', exitCode: 0 }] };
const report = { execution: 'OPENAI_ADAPTER', incidentId: 'INC-001', outcome: { status: 'COMPLETED',
  diagnosis: { summary: 'Synthetic offline script assessment.', probableCause: 'Fixture dependency timeout.', confidence: 'low', evidence: ['Synthetic log evidence.'], recommendedActions: [] },
  toolExecutions: [{ callId: 'call-1', toolName: 'search_logs', status: 'SUCCEEDED' }] }, verificationReady: true, traceComplete: true,
  observed: { requestedTools: [{ callId: 'call-1', toolName: 'search_logs' }], deliveredCallIds: ['call-1'] }, humanDiagnosisReview: 'PENDING',
  cleanup: { mcpClose: 'SUCCEEDED', childExit: 'OBSERVED', tracingShutdown: 'SUCCEEDED', errors: [] } };

// This fixture is a fail-closed local executable. It cannot invoke AWS or any network client.
const fakeCli = String.raw`
$ErrorActionPreference = 'Stop'
$scenario = Get-Content -LiteralPath $env:INCIDENTOPS_FAKE_SCENARIO -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$index = [Array]::IndexOf([object[]]$args, '--cli-input-json')
if ($index -lt 0) { exit 9 }
$requestPath = ([string]$args[$index + 1]).Substring(7)
$inputData = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$previous = @()
if (Test-Path -LiteralPath $env:INCIDENTOPS_FAKE_CALLS) { $previous = @(Get-Content -LiteralPath $env:INCIDENTOPS_FAKE_CALLS | ForEach-Object { ConvertFrom-Json -InputObject $_ -AsHashtable -Depth 100 }) }
$service = [string]$args[0]; $operation = [string]$args[1]
$record = @{ service = $service; operation = $operation; input = $inputData; maximumAttempts = $env:AWS_MAX_ATTEMPTS } | ConvertTo-Json -Depth 100 -Compress
[IO.File]::AppendAllText($env:INCIDENTOPS_FAKE_CALLS, $record + [Environment]::NewLine)
$ordinal = @($previous | Where-Object { $_['operation'] -eq $operation }).Count
$kind = $scenario['kind']
if ($service -eq 'ecs' -and $operation -eq 'describe-task-definition') { @{ taskDefinition = $scenario['definition'] } | ConvertTo-Json -Depth 100; exit 0 }
if ($service -eq 'ecs' -and $operation -eq 'run-task') {
  if ($kind -eq 'cli-failure') { Write-Output 'SYNTHETIC_PRIVATE_DIAGNOSTIC'; exit 1 }
  if ($kind -eq 'failures') { @{ tasks = @(); failures = @(@{ reason = 'CAPACITY' }) } | ConvertTo-Json -Depth 100; exit 0 }
  if ($kind -eq 'ambiguous') { @{ tasks = @(); failures = @() } | ConvertTo-Json -Depth 100; exit 0 }
  $fingerprint = $inputData['cluster'] + '|' + $inputData['taskDefinition'] + '|' + ($inputData['overrides']['containerOverrides'][0]['command'] -join ',')
  if (Test-Path -LiteralPath $env:INCIDENTOPS_FAKE_STATE) {
    $state = Get-Content -LiteralPath $env:INCIDENTOPS_FAKE_STATE -Raw | ConvertFrom-Json -AsHashtable
    if ($state['token'] -ne $inputData['clientToken'] -or $state['fingerprint'] -ne $fingerprint) { Write-Output 'ConflictException'; exit 1 }
  } else { @{ token = $inputData['clientToken']; fingerprint = $fingerprint; createdTasks = 1 } | ConvertTo-Json | Set-Content -LiteralPath $env:INCIDENTOPS_FAKE_STATE }
  $scenario['launch'] | ConvertTo-Json -Depth 100; exit 0
}
if ($service -eq 'ecs' -and $operation -eq 'describe-tasks') {
  if ($kind -eq 'eventual' -and $ordinal -lt 2) { @{ tasks = @(); failures = @(@{ reason = 'MISSING' }) } | ConvertTo-Json -Depth 100; exit 0 }
  $stopped = $scenario['stopped']
  $stopCalls = @($previous | Where-Object { $_['operation'] -eq 'stop-task' }).Count
  if (($kind -eq 'deadline' -and $stopCalls -eq 0) -or $kind -eq 'stop-unobserved') {
    $running = @{}; foreach ($key in $stopped.Keys) { $running[$key] = $stopped[$key] }
    $running['lastStatus'] = 'RUNNING'; $running['containers'] = @(@{ name = 'incidentops-agent'; lastStatus = 'RUNNING' })
    @{ tasks = @($running); failures = @() } | ConvertTo-Json -Depth 100; exit 0
  }
  @{ tasks = @($stopped); failures = @() } | ConvertTo-Json -Depth 100; exit 0
}
if ($service -eq 'ecs' -and $operation -eq 'stop-task') { @{ task = $scenario['stopped'] } | ConvertTo-Json -Depth 100; exit 0 }
if ($service -eq 'logs' -and $operation -eq 'get-log-events') {
  if ($kind -eq 'delayed-logs' -and $ordinal -eq 0) { Write-Output 'ResourceNotFoundException'; exit 1 }
  $token = $inputData['nextToken']
  if ($kind -eq 'incomplete-logs') {
    $events = if ($null -eq $token) { @(@{ message = '{' }) } else { @() }
    @{ events = @($events); nextForwardToken = 'end' } | ConvertTo-Json -Depth 100; exit 0
  }
  $lines = ($scenario['report'] | ConvertTo-Json -Depth 100) -split '\r?\n'
  $cut = [Math]::Floor($lines.Count / 2)
  if ($null -eq $token) { $events = @($lines[0..($cut-1)] | ForEach-Object { @{ message = $_ } }); $next = 'middle' }
  elseif ($token -eq 'middle') { $events = @(); $next = 'body' }
  elseif ($token -eq 'body') { $events = @($lines[$cut..($lines.Count-1)] | ForEach-Object { @{ message = $_ } }); $next = 'end' }
  else { $events = @(); $next = 'end' }
  @{ events = @($events); nextForwardToken = $next } | ConvertTo-Json -Depth 100; exit 0
}
Write-Output 'OFFLINE_FAKE_ONLY: unexpected command'; exit 9
`;

function fixture(t, change = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'incidentops-aws-offline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(['scenario', 'calls', 'state', 'fake'].map(key => [key, join(directory, key + (key === 'fake' ? '.ps1' : '.json'))]));
  const scenario = structuredClone({ kind: 'success', definition, stopped, report, launch: { tasks: [stopped], failures: [] } });
  change(scenario);
  writeFileSync(paths.scenario, JSON.stringify(scenario)); writeFileSync(paths.fake, fakeCli);
  function run(extra = {}, execute = true) {
    const parameters = { Region: 'us-east-1', Cluster: cluster, TaskDefinition: 'incidentops-agent:7', SubnetIds: 'subnet-0123456789abcdef0',
      SecurityGroupId: 'sg-0123456789abcdef0', IncidentId: 'INC-001', ClientToken: 'explicit-stable-attempt', AssignPublicIp: 'ENABLED',
      ObservationTimeoutSeconds: '5', LogDeliveryTimeoutSeconds: '5', StopObservationTimeoutSeconds: '3', PollIntervalMilliseconds: '10',
      AwsExecutable: paths.fake, ...extra };
    const args = ['-NoProfile', '-NonInteractive', '-File', script];
    if (execute) args.push('-Execute');
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined || value === false) continue;
      args.push('-' + key); if (value !== true) args.push(value);
    }
    const result = spawnSync(pwsh, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env,
      INCIDENTOPS_FAKE_SCENARIO: paths.scenario, INCIDENTOPS_FAKE_CALLS: paths.calls, INCIDENTOPS_FAKE_STATE: paths.state,
      AWS_CONFIG_FILE: join(directory, 'absent-config'), AWS_SHARED_CREDENTIALS_FILE: join(directory, 'absent-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true' } });
    assert.ifError(result.error);
    assert.equal(result.stderr, '', 'No raw PowerShell/AWS diagnostics may escape');
    return { code: result.status, data: JSON.parse(result.stdout) };
  }
  return { run, paths, calls: () => existsSync(paths.calls) ? readFileSync(paths.calls, 'utf8').trim().split(/\r?\n/).map(JSON.parse) : [] };
}

if (!pwsh) {
  test('PowerShell 7 runtime safety checks unavailable', { skip: 'Install PowerShell 7 or set INCIDENTOPS_PWSH; static security tests above still run.' }, () => {});
} else {
  test('AWS runner defaults to local plan-only and validates before any fake AWS command', t => {
    const f = fixture(t);
    const plan = f.run({}, false);
    assert.equal(plan.code, 0); assert.equal(plan.data.status, 'PLAN_ONLY'); assert.deepEqual(f.calls(), []);
    assert.equal(plan.data.request.count, 1); assert.equal(plan.data.request.clientToken, 'explicit-stable-attempt');
    assert.deepEqual(plan.data.request.overrides.containerOverrides[0].command, ['dist/run-investigation.js', '--live', '--incident', 'INC-001']);
    for (const extra of [{ Region: '' }, { TaskDefinition: 'incidentops-agent' }, { AssignPublicIp: undefined }, { ClientToken: '' }, { DryRun: true }]) {
      assert.equal(f.run(extra).code, 2); assert.deepEqual(f.calls(), []);
    }
  });
  test('AWS runner verifies one task, paginated logs including an empty page, MCP evidence and pending human review', t => {
    const f = fixture(t); const result = f.run();
    assert.equal(result.code, 0); assert.equal(result.data.status, 'SUCCEEDED'); assert.equal(result.data.taskArn, taskArn);
    assert.equal(result.data.humanDiagnosisQuality, 'PENDING'); assert.equal(result.data.mcpEvidenceVerified, true);
    assert.equal(result.data.diagnosisStructureValid, true); assert.equal(result.data.containerExitedSuccessfully, true);
    assert.deepEqual(result.data.diagnosis, report.outcome.diagnosis);
    const calls = f.calls(); assert.equal(calls.filter(x => x.operation === 'run-task').length, 1);
    assert.ok(calls.every(x => x.maximumAttempts === '1'));
    const launched = calls.find(x => x.operation === 'run-task').input;
    assert.equal(launched.taskDefinition, definitionArn); assert.equal(launched.launchType, 'FARGATE'); assert.equal(launched.count, 1);
    assert.equal(launched.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'ENABLED');
    const logs = calls.filter(x => x.service === 'logs'); assert.equal(logs.length, 4);
    assert.ok(logs.every(x => x.input.logStreamName === 'investigation/incidentops-agent/' + 'a'.repeat(32)));
    assert.equal(calls.filter(x => x.operation === 'stop-task').length, 0);
  });
  test('AWS runner passes the requested incident ID without hardcoding INC-001', t => {
    const f = fixture(t, s => { s.report.incidentId = 'INC-002'; });
    assert.equal(f.run({ IncidentId: 'INC-002' }).code, 0);
    assert.equal(f.calls().find(x => x.operation === 'run-task').input.overrides.containerOverrides[0].command.at(-1), 'INC-002');
  });
  for (const kind of ['failures', 'ambiguous', 'cli-failure']) test('AWS runner requires reconciliation without another launch: ' + kind, t => {
    const f = fixture(t, s => { s.kind = kind; }); const result = f.run();
    assert.equal(result.code, 1); assert.equal(result.data.category, 'RECONCILIATION_REQUIRED');
    assert.equal(f.calls().filter(x => x.operation === 'run-task').length, 1);
    assert.equal(f.calls().filter(x => x.operation === 'stop-task').length, 0);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  });
  test('AWS runner rejects a foreign launch response without stopping an unrelated task', t => {
    const f = fixture(t, s => { s.launch.tasks[0].clusterArn = cluster + '-other'; }); const result = f.run();
    assert.equal(result.data.category, 'RECONCILIATION_REQUIRED'); assert.equal(result.code, 1);
    assert.equal(f.calls().filter(x => x.operation === 'stop-task').length, 0);
  });
  test('AWS runner tolerates bounded task eventual consistency and delayed log delivery', t => {
    for (const kind of ['eventual', 'delayed-logs']) {
      const f = fixture(t, s => { s.kind = kind; }); assert.equal(f.run().code, 0);
      assert.equal(f.calls().filter(x => x.operation === 'run-task').length, 1);
    }
  });
  test('AWS runner never calls a nonzero container exit successful', t => {
    const f = fixture(t, s => { s.stopped.containers[0].exitCode = 137; }); const result = f.run();
    assert.equal(result.code, 1); assert.equal(result.data.category, 'CONTAINER_EXIT_UNSUCCESSFUL');
    assert.equal(result.data.containerExitedSuccessfully, false);
  });
  for (const kind of ['deadline', 'stop-unobserved']) test('AWS runner bounds observation and stops only its known task: ' + kind, t => {
    const f = fixture(t, s => { s.kind = kind; });
    const result = f.run({ ObservationTimeoutSeconds: '1', StopObservationTimeoutSeconds: '1' });
    assert.equal(result.code, 1); assert.equal(result.data.category, 'OBSERVATION_DEADLINE');
    const stops = f.calls().filter(x => x.operation === 'stop-task'); assert.equal(stops.length, 1);
    assert.equal(stops[0].input.task, taskArn); assert.equal(result.data.operatorCleanup.stopRequested, true);
    assert.equal(result.data.operatorCleanup.stoppedObserved, kind === 'deadline');
    assert.equal(f.calls().filter(x => x.operation === 'run-task').length, 1);
  });
  test('AWS runner refuses truncated log reports', t => {
    const f = fixture(t, s => { s.kind = 'incomplete-logs'; }); const result = f.run({ LogDeliveryTimeoutSeconds: '1' });
    assert.equal(result.code, 1); assert.equal(result.data.category, 'LOGS_INCOMPLETE');
    assert.equal(result.data.verificationReady, false);
  });
  for (const [name, change, category] of [
    ['missing diagnosis field', s => { delete s.report.outcome.diagnosis.probableCause; }, 'DIAGNOSIS_INVALID'],
    ['missing MCP evidence', s => { s.report.observed.deliveredCallIds = []; }, 'MCP_EVIDENCE_MISSING'],
    ['case-substituted call ID', s => { s.report.outcome.toolExecutions[0].callId = 'CALL-1'; }, 'MCP_EVIDENCE_MISSING'],
    ['claimed human PASS', s => { s.report.humanDiagnosisReview = 'PASS'; }, 'REPORT_INVALID'],
    ['incomplete CLI cleanup', s => { s.report.cleanup.childExit = 'NOT_OBSERVED'; }, 'REPORT_CLEANUP_INCOMPLETE'],
  ]) test('AWS runner rejects ' + name, t => {
    const f = fixture(t, change); const result = f.run(); assert.equal(result.code, 1); assert.equal(result.data.category, category);
  });
  test('AWS runner refuses unsafe task definition plaintext credentials before launch', t => {
    const f = fixture(t, s => { s.definition.containerDefinitions[0].environment.push({ name: 'OPENAI_API_KEY', value: 'SYNTHETIC_FORBIDDEN_VALUE' }); });
    const result = f.run(); assert.equal(result.code, 1); assert.equal(result.data.category, 'TASK_DEFINITION_UNSAFE');
    assert.equal(f.calls().filter(x => x.operation === 'run-task').length, 0);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_FORBIDDEN_VALUE'));
  });
  test('AWS duplicate attempt uses the same token and request; fake idempotency creates only one task', t => {
    const f = fixture(t); assert.equal(f.run().code, 0); assert.equal(f.run().code, 0);
    assert.equal(JSON.parse(readFileSync(f.paths.state, 'utf8')).createdTasks, 1);
    const launches = f.calls().filter(x => x.operation === 'run-task');
    assert.equal(launches.length, 2); assert.ok(launches.every(x => x.input.clientToken === 'explicit-stable-attempt'));
    const conflict = f.run({ IncidentId: 'INC-002' }); assert.equal(conflict.code, 1); assert.equal(conflict.data.category, 'RECONCILIATION_REQUIRED');
    assert.equal(JSON.parse(readFileSync(f.paths.state, 'utf8')).createdTasks, 1);
  });
}
