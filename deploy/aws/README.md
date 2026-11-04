# AWS standalone investigation deployment

The deployment configuration was first verified offline. A later authorized standalone ECS Fargate task completed one real-provider investigation of synthetic INC-001. All four MCP read-tool executions succeeded, the structured Diagnosis passed validation and the task exited successfully. The project controller reviewed the supplied investigation report and recorded PASS. The machine-generated `humanDiagnosisQuality` remains `PENDING`. No separate structured user adjudication was recorded for this cloud run.

The provisioned resources were subsequently cleaned up. Final AWS billing reconciliation remains **PENDING**. See the [evaluation report](../../docs/evaluation.md#single-real-provider-aws-investigation) for the evidence boundaries.

Resource creation, image uploads, AWS verification tasks and a single live OpenAI investigation each require separate explicit authorization. `-Execute` is an operator opt-in, not a substitute for that authorization.

## Architecture and boundaries

Use one private ECR image and one ECS Fargate standalone task. The accepted image contains the Service and CLI modes. This task runs the existing CLI and its local MCP stdio subprocess; it does not turn `/health` into an investigation API. The AWS configuration includes no ECS Service, ALB, Lambda, database, additional MCP server, NAT gateway or VPC endpoint. The separate GitHub Actions workflow builds and tests the project without deploying it. See the [architecture overview](../../docs/architecture.md#runtime-and-aws-deployment).

The image retains `ENTRYPOINT ["node"]`. The task definition defaults to `dist/run-investigation.js` without `--live`, so accidentally starting it without an override fails local argument validation (exit 2) instead of starting an investigation or idling a health server. The runner supplies `dist/run-investigation.js --live --incident <requested-ID>` as an argument array. Never prepend `node` or enable `--inspect` in this deployment.

Existing application limits and policies remain unchanged: five model turns, four actual tool attempts, 30-second model/tool waits, 31-second model SDK request timeout, 10-second MCP connect timeout, 2048 output tokens, no SDK retry. The model sees four read tools. There is no automatic approval or complete-investigation retry. INC-001 and the other supported cases remain synthetic fixtures, not production incidents. OpenAI model and embedding requests both can incur charges; the CLI token report excludes embedding usage and billing completeness.

## Safe offline validation — no AWS access

Requirements: the project's existing Node.js dependencies and PowerShell 7. No AWS CLI or credentials are needed for the offline tests.

From the repository root:

```powershell
node -e "JSON.parse(require('node:fs').readFileSync('deploy/aws/fargate.json','utf8')); console.log('JSON syntax OK')"
node --check test/aws-deployment.test.js
$tokens = $null; $parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/aws/run-once.ps1'), [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw 'PowerShell syntax validation failed' }
# If pwsh is not on PATH, supply the installed PowerShell 7 executable for child tests:
$env:INCIDENTOPS_PWSH = (Get-Process -Id $PID).Path
npm test
node --test test/aws-deployment.test.js
```

Tests use a fail-closed, temporary fake AWS CLI, synthetic ARNs and synthetic reports. They never invoke the real AWS executable, read actual AWS credential files, load `.env`, or call a provider. PowerShell runtime tests are explicitly reported unavailable if PowerShell 7 cannot be found; static security tests always run. Fake idempotency tests exercise the documented request contract, not actual AWS behavior.

JSON parsing and these assertions do **not** establish CloudFormation deployment validity, account permissions, live secret type, available subnets, image availability or runtime capacity. Do not run `aws cloudformation validate-template` as an offline check: it contacts AWS.

- **Historical offline AWS integration baseline:** local `npm test` recorded 404/404 PASS before six additional regression tests.
- **Separate Docker application scope:** Linux build-test recorded 380/380 PASS. The final `.dockerignore` rule after the root-test allow rule excludes exactly `test/aws-deployment.test.js`, and `deploy/aws` remains excluded. This scope requires neither PowerShell nor AWS control-plane files. The separate complete Docker acceptance still expects 11/11.
- **GitHub-hosted CI:** the first verified complete run recorded 410/410 PASS. The second run succeeded after the Action runtime upgrades. Its exact test count was not independently captured.

AWS deployment tests remain part of local `npm test` and use only the controlled fake CLI; no AWS or real provider access is needed for either offline verification path.

## AWS prerequisites — later authorization required

Before any AWS command, the operator must confirm the account/billing, approved Region, AWS and OpenAI spending limits, IAM/SSO access, resource-creation permission and OpenAI model/project access. Install/configure AWS CLI v2 through an approved route. Never provide credentials as script arguments or commit local account configuration.

Supply an **existing** VPC and subnet IDs in the selected Region, with available IPs and working DNS. For the minimal public-subnet design, the subnet needs an existing route to an internet gateway and the operator must explicitly approve `AssignPublicIp=ENABLED`. This template does not create or repair VPCs, subnets, routes, internet gateways, NAT or endpoints. `DISABLED` is accepted only as an explicit operator choice; without an existing approved outbound path it cannot reach ECR/AWS services/OpenAI.

The dedicated security group has no ingress and only TCP 443 outbound to IPv4 destinations. This is not a domain allowlist. VPC DNS, network ACLs and the actual outbound route must be checked separately. No port mapping or public investigation endpoint is configured.

## Phase 1 — base resources (AWS operations, do not run without approval)

`fargate.json` creates exactly five base resources: private immutable-tag ECR repository, ECS cluster, seven-day CloudWatch log group, task execution role and dedicated security group in the supplied VPC. Names use `ProjectName`; choose a unique approved name for the account/Region. No task is started by stack creation.

The following variables are operator-supplied non-secret identifiers, not defaults selected by this project:

```powershell
$Region = '<approved-region>'
$Vpc = '<existing-vpc-id>'
$Project = '<unique-lowercase-project-name>'
$Stack = '<approved-stack-name>'
aws cloudformation deploy --region $Region --stack-name $Stack --template-file deploy/aws/fargate.json --capabilities CAPABILITY_IAM --parameter-overrides VpcId=$Vpc ProjectName=$Project EnableTaskDefinition=false
aws cloudformation describe-stacks --region $Region --stack-name $Stack --query 'Stacks[0].Outputs'
```

Review the change set/IAM permissions and estimated costs before deployment. Save owned resource IDs privately for cleanup. Cluster creation may require an ECS service-linked role in the account. Verify this requirement for the target account.

## Publish the existing image and verify its ECR digest (AWS operations)

Only after upload authorization, obtain `RepositoryUri` from stack outputs and confirm the local image is the accepted Step 2 image. Do not rebuild, add secrets, or mount private data into it for publishing.

```powershell
$RepositoryUri = '<RepositoryUri-output>'
$Registry = ($RepositoryUri -split '/')[0]
$ImageTag = 'step2-1f33308877de'
$TaggedImage = $RepositoryUri + ':' + $ImageTag
aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $Registry
docker tag incidentops-agent:week4-step2 $TaggedImage
docker push $TaggedImage
$Digest = aws ecr describe-images --region $Region --repository-name $Project --image-ids imageTag=$ImageTag --query 'imageDetails[0].imageDigest' --output text
aws ecr batch-get-image --region $Region --repository-name $Project --image-ids imageDigest=$Digest --query 'images[0].imageId.imageDigest' --output text
```

The digest must be the **registry manifest digest** verified in ECR. A local `docker image inspect` image ID has a similar shape but is not interchangeable. Static checks can validate the shape only. Immutable tags prevent silently replacing a release; retain the previous reviewed digest when rollback may be needed.

## SecureString and IAM (separate AWS authorization)

An authorized operator creates a Standard **SecureString** through an approved secure secret-entry route, such as the SSM console. Do not enter the actual key into this repository, terminal examples, stack parameters, images or plaintext task environment. Only its ARN is supplied here. CloudFormation does not support creating SecureString via `AWS::SSM::Parameter`; this template creates no parameter resource.

Use a parameter in the task's account/Region. ECS injects it as `OPENAI_API_KEY` through `secrets.valueFrom`. Supply the separately approved non-secret `OpenAIModel`. Secret changes require a new task; running tasks do not automatically receive rotated values.

The execution role grants ECR authorization (the required resource `*`), image pulls from only the owned repository, writes to only the owned log streams, and conditional `ssm:GetParameters` for only the supplied parameter ARN. Supply `CustomerManagedKmsKeyArn` **only** when that existing parameter actually uses that CMK; only then is a single-key `kms:Decrypt` statement added. No application task role or AdministratorAccess is granted.

The deployment principal needs reviewed CloudFormation/IAM/ECR/network permissions for the owned resources. The upload principal needs ECR authorization/upload permissions for the owned repository. The runner principal needs `ecs:DescribeTaskDefinition`, `ecs:RunTask`, bounded `ecs:DescribeTasks`/`ecs:StopTask`, `logs:GetLogEvents` for the task log group and `iam:PassRole` for only the execution role with `iam:PassedToService=ecs-tasks.amazonaws.com`. Some metadata/auth actions require resource `*`; do not generalize that to other actions. Provisioning and runtime identities should remain separate.

## Phase 2 — activate the task definition (AWS operations)

After the actual registry digest, existing SecureString ARN and model ID are known:

```powershell
$KeyArn = '<existing-ssm-securestring-arn>'
$Model = '<approved-model-id>'
$KmsArn = '' # Only a required customer-managed key ARN, otherwise leave empty.
aws cloudformation deploy --region $Region --stack-name $Stack --template-file deploy/aws/fargate.json --capabilities CAPABILITY_IAM --parameter-overrides VpcId=$Vpc ProjectName=$Project EnableTaskDefinition=true ImageDigest=$Digest OpenAIKeyParameterArn=$KeyArn OpenAIModel=$Model CustomerManagedKmsKeyArn=$KmsArn
```

Conditions gate the task definition and secret policies; a Rules assertion rejects an activation request missing any required input rather than silently accepting placeholders. Registration does not run a task. Candidate resources are 256 CPU units/1024 MiB, LINUX/X86_64, UID 1000, init process and 30-second stop timeout. The single completed AWS run does not establish workload capacity under these limits. ARM64 is not verified.

## Dry-run example — safe, no network

These identifiers are explicitly synthetic. Replace them with approved identifiers only for later execution. A full cluster ARN and a task definition family:revision or full revision ARN are required; `latest`/unqualified family names are rejected.

```powershell
$Run = @{
  Region = 'us-east-1'
  Cluster = 'arn:aws:ecs:us-east-1:111122223333:cluster/incidentops-agent'
  TaskDefinition = 'incidentops-agent:7'
  SubnetIds = @('subnet-0123456789abcdef0')
  SecurityGroupId = 'sg-0123456789abcdef0'
  IncidentId = 'INC-001'
  ClientToken = 'operator-approved-attempt-001'
  AssignPublicIp = 'ENABLED'
}
./deploy/aws/run-once.ps1 @Run -DryRun
```

Without `-Execute`, the script only validates local inputs and emits `PLAN_ONLY`. It does not discover AWS, create temporary request files or call any AWS APIs. An invalid configuration returns exit 2 before AWS access. It never loads `.env` or accepts a secret value.

## One separately authorized live investigation

Only after explicit AWS execution and paid provider authorization, with the real approved identifiers:

```powershell
./deploy/aws/run-once.ps1 @Run -Execute
```

The script describes the exact revision first and checks its runtime, pinned image, secret reference, read-only deployment shape and logging configuration. It performs **one** RunTask with `count=1`, `launchType=FARGATE`, explicit network/public-IP choice and the caller's stable token. Do not change tokens to get around an error. AWS CLI attempts are temporarily set to one and restored afterward. The test-only `-AwsExecutable` override is used solely for the controlled offline fake; production use defaults to AWS CLI v2.

Idempotency is supplied by AWS within its service-defined token lifetime, not a permanent exactly-once ledger. The same logical attempt must retain its token and all request parameters. A transport error, response failures, wrong identity or ambiguous task count returns `RECONCILIATION_REQUIRED` without a new launch or speculative stop of an unknown task. A task might already exist and incur charges; reconcile it through the authorized operator before any further execution.

## Monitoring, diagnosis and acceptance

The operator observation deadline defaults to 600 seconds (maximum 600), with bounded polling for task eventual consistency. AWS connect/read timeouts are five seconds and retries are disabled. Missing task information never establishes success. On observation failure/deadline, the script requests StopTask only for the positively identified task and observes stopping for up to 45 additional seconds. Log delivery has a separate default 30-second bound (maximum 60).

This is **not** a guaranteed AWS task runtime or spending limit. Credential-provider delays, a killed operator process or unreachable AWS APIs can defeat local cleanup. `stopTimeout=30` is only the stop-signal grace period before forceful termination; it is not a job deadline. An unobserved stop is explicitly reported. Never automatically launch a replacement investigation.

Logs come only from `<prefix>/incidentops-agent/<task-ID>` in the inspected task definition's log group/Region. Pagination follows forward tokens through empty pages until the token stabilizes, bounded by time, 100 pages per snapshot and 1 MiB of text. Missing streams, delayed delivery and truncated JSON never count as success. Arbitrary raw AWS diagnostics/log lines are not printed. Unknown stopped reasons are redacted to a category; inspect detailed reasons separately through an authorized AWS console session if needed.

The result distinguishes task start, container exit, workflow completion, verification readiness, correlated successful MCP execution/delivery, Diagnosis structure and CLI cleanup. Success requires all of those, including observed child exit and tracing shutdown. Only the selected structured Diagnosis and execution metadata are emitted, without raw arguments/tool outputs. The complete source report remains in the private CloudWatch stream; no local report is written automatically. CLI stdout is a final report, not continuous progress. CloudWatch delivery loss remains possible and causes failed/incomplete verification.

`humanDiagnosisQuality` always remains **PENDING**. An image pull, RUNNING status, exit 0, valid JSON or mock test is not human quality PASS or real LLM performance. A later human review must assess the actual saved outcome. The known application-only authorization boundary for the simulated action remains unchanged.

## Costs, cleanup and rollback

Budget Fargate compute/image-pull time (Linux minimum one minute), public IPv4, ECR storage, CloudWatch ingestion/storage/read APIs, secret/KMS usage, network transfer, and OpenAI model plus embedding charges outside AWS billing. Standard parameter storage has no additional parameter fee, but that does not make this deployment free. Check current Region-specific pricing; assume no credits/free tier. A stopped task leaves images, logs and possibly other account-owned billable resources.

After separate cleanup authorization: confirm the recorded task has stopped, privately preserve required evidence, delete only the owned repository's images, and delete the owned CloudFormation stack. The nonempty repository must be handled explicitly; do not force-delete unrelated repositories. The log group has DeletionPolicy Delete, so export needed evidence before deleting the stack. The separately created secret is not owned by this stack: delete/revoke it only if dedicated and explicitly authorized. Never delete shared VPC/subnet/IGW resources. Inspect for residual task/network resources and ongoing charges.

Rollback selects a previous verified ECR digest/task revision; it does not automatically run another paid investigation. No ECS Service exists to roll back or continually restart a failed one-shot command. The historical verification applies to the completed run. For any future deployment, separately authorize and verify deployment validity, IAM permissions, runtime capacity, live networking, secret injection and live provider execution for the target configuration.

References: [CloudFormation task definition](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ecs-taskdefinition.html), [SSM injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-ssm-paramstore.html), [RunTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html), [GetLogEvents pagination](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_GetLogEvents.html).
