# IncidentOps Agent

A TypeScript agent that investigates synthetic service incidents using LLM tool calling, the Model Context Protocol (MCP), and structured diagnosis. The model chooses which evidence to request. The application enforces tool permissions, budgets, timeouts, retries, approval and output validation so that a model proposal cannot bypass execution policy.

## Quick Start

Use Node.js 22.14.0 or later and npm. Run these commands from the repository root.

```bash
npm ci --include=dev --include=optional --no-audit --no-fund
npm run build
node dist/evaluation/run-baseline.js
```

Installation uses the committed lockfile and may access the npm registry. The baseline runs locally with scripted model responses, deterministic embeddings and synthetic fixtures. It needs no AWS account, OpenAI key or paid API calls. Expect a JSON report with five completed workflows, 20/20 required tool observations covered and diagnosis correctness marked `NOT_EVALUATED`. Review raw evaluation output before sharing it. Some runners include evaluator-only expected causes or Ground Truth.

## Engineering Features

- **Investigation tools.** A single agent uses an OpenAI Responses adapter. The official MCP Client and Server communicate over local stdio. Four read tools provide synthetic logs, metrics, service metadata and runbook results. Runbook search ranks semantic matches and falls back to lexical matching only on explicit semantic retrieval unavailability.
- **Execution controls.** The application enforces model-turn and tool-attempt budgets, caller timeouts and at most one retry for recognized timeout failures on approved reads, subject to remaining budget. A separate approval-capable workflow can pause for trusted human approval before a simulated `restart_service`.
- **Outcome and observability.** Runtime diagnosis validation checks the structured result. Investigation records track workflow state and tool attempts. Evaluation runners exercise the same orchestration with scripted inputs, and optional instrumentation captures caller waits, observed model usage and in-memory OpenTelemetry spans.
- **Delivery.** A shared Docker image packages the HTTP and CLI entry points. Operator-controlled AWS configuration supports a standalone ECS Fargate task. GitHub Actions checks compilation and offline behavior.

## Architecture

**The model proposes and interprets. The application authorizes, executes, validates and terminates.**

The investigation CLI selects a synthetic incident and creates a session. `AgentOrchestrator` asks the model adapter for tool proposals or a final diagnosis. After policy checks, `ToolExecutor` validates and routes requests through the MCP client to the server's read handlers. Tool results return to the next model turn with their original call IDs. The application validates the diagnosis and records the outcome, execution attempts and available observations. See the [investigation and deployment diagrams](docs/architecture.md).

## Application Entry Points

### HTTP health check

After building, run `npm start`. The NestJS/Fastify service exposes `GET /health` on port 3000 by default.

```bash
curl http://localhost:3000/health
```

The response is `{"status":"ok"}`. Investigations use the separate CLI below.

### Optional live investigation

After building, configure `OPENAI_API_KEY` and `OPENAI_AGENT_MODEL` in the process environment. The following command explicitly opts in to real provider requests. Model and embedding calls may incur charges.

```bash
npm run investigate -- --live --incident INC-001
```

The CLI runs one investigation and emits a JSON report. Its model sees only the four read tools. The simulated restart path is exercised separately.

## Testing and Evaluation

Use PowerShell 7 or later on PATH for the complete suite, including the fake AWS CLI tests. After building, run the same serial test command used in [GitHub Actions](.github/workflows/ci.yml).

```bash
node --test --test-concurrency=1 test/*.test.js
```

- **Historical CI.** The first GitHub-hosted run passed 410 of 410 tests, with zero failures, skips or cancellations. The second run succeeded after the Action runtime upgrades. Its exact test count was not independently captured.
- **Scripted evaluation.** The baseline completed 5/5 workflows and covered 20/20 required tool observations. The expanded run completed 30/30 workflows and covered 85/85 required observations.
- **Historical human assessment.** Reviews of 30 saved scripted outcomes recorded Tool Correctness at 30/30 PASS and Task Success at 0/30 PASS. Task Success requires completion plus passing judgments for cause, evidence and actions.

These are separate measures of software behavior, workflow completion, tool coverage and reviewed quality. The [evaluation report](docs/evaluation.md) explains the denominators, reproduction commands and evidence limits.

## Docker and AWS

The [Dockerfile](Dockerfile) builds a shared non-root image. Its default command starts the health service. A command override runs the investigation CLI. The AWS configuration supports publishing the image to ECR, running one digest-pinned ECS Fargate task, injecting a provider key from SSM SecureString through the execution role, and collecting stdout through CloudWatch Logs. The operator controls provisioning, task execution and cleanup. See the [AWS operator guide](deploy/aws/README.md).

One real-provider investigation of synthetic INC-001 completed on Fargate. Four MCP read-tool executions succeeded, the structured diagnosis passed validation and the task terminated successfully. The project controller reviewed the diagnosis and recorded PASS based on the supplied report. The machine-generated review field remains `PENDING`. No separate structured user adjudication was recorded for this cloud run. Deployment resources were subsequently cleaned up. Final AWS billing reconciliation remains pending.

## Project Structure

```text
src/agent/        Orchestration, model adapter and execution policy
src/mcp/          MCP client, stdio entry and server
src/tools/        Operational tool handlers and simulated restart
src/rag/          Runbook embeddings, ranking and fallback
src/domain/       Incident, diagnosis and investigation contracts
src/evaluation/   Scripted datasets, runners and quality assessment
src/measurement/  Caller timing and observed model usage
src/tracing/      In-memory OpenTelemetry spans
test/            Unit, integration and deployment checks
docs/            Architecture and evaluation evidence
deploy/aws/      Fargate template, runner and operator guide
```

## Limitations and Safety

- Operational data is synthetic. Scripted results do not measure real LLM diagnosis accuracy. The single Fargate run demonstrates one execution.
- `AgentOrchestrator` enforces approval for the simulated restart. Direct MCP access has no independent approval gate. The live CLI exposes only the four approved read tools.
- Investigation and approval state live in memory. Tracing uses in-memory spans. Usage summaries cover observed model responses and exclude embedding usage and billing.
- Timeouts bound caller waiting. Underlying work can continue. CI builds and tests the project, and deployment remains an operator action.

## Documentation

- [Architecture and execution boundaries](docs/architecture.md)
- [Evaluation results and reproduction](docs/evaluation.md)
- [AWS deployment and cleanup guide](deploy/aws/README.md)
