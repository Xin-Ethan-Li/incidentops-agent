# IncidentOps Agent Evaluation

## Evaluation Overview

The evidence covers software behavior, scripted workflow execution, human assessment of saved scripted outputs, and one real-provider cloud investigation. These answer different questions. A workflow can complete with valid output structure and appropriate tool requests while producing a poor diagnosis. The saved quality assessment demonstrates that distinction directly.

## Evaluation Scope and Environment

The incident inputs and operational evidence are synthetic. The reproducible runners use the existing Agent and tool execution path with scripted model responses, local MCP transport and deterministic embeddings. The historical GitHub Actions environment used Ubuntu 24.04, Node.js 22 and PowerShell 7 or later. The repository requires Node.js 22.14.0 or later. Use Node.js 22 to match CI.

See the [architecture](architecture.md), [package configuration](../package.json) and [CI workflow](../.github/workflows/ci.yml).

## Automated Software Tests

| Layer | What it checks | Examples |
| --- | --- | --- |
| Unit | Fixture tools, input handling and diagnosis shape | [Tools](../test/tools.test.js), [diagnosis](../test/diagnosis.test.js) |
| Integration | NestJS/Fastify health endpoint and end-to-end fixture investigations | [Health](../test/health.e2e.test.js), [Week 1 integration](../test/week1-integration.test.js) |
| MCP boundary | Tool contracts, local transports and evidence delivery with original call IDs | [MCP](../test/mcp.test.js), [live-session integration with mocked provider](../test/live-investigation.test.js) |
| Workflow controls | Budget enforcement, timeouts, bounded retry, fallback and approval for simulated restart | [Budget](../test/tool-budget.test.js), [timeout](../test/timeout.test.js), [retry](../test/retry.test.js), [fallback](../test/fallback.test.js), [approval](../test/approval.test.js) |
| Evaluation and observation | Case isolation, scoring, quality review validation, timing, usage and spans | [Expansion](../test/evaluation-expansion.test.js), [quality](../test/quality.test.js), [measurement](../test/measurement.test.js), [usage](../test/model-usage.test.js), [tracing](../test/tracing.test.js) |
| Docker | Separate container build, health, mocked investigation and cleanup checks | [Docker acceptance](../test/docker/container.test.js), [Dockerfile](../Dockerfile) |
| AWS deployment | Template and runner behavior using a local fake CLI | [AWS deployment tests](../test/aws-deployment.test.js) |

The first GitHub-hosted CI run recorded **410 tests, 410 passed, 0 failed, 0 skipped and 0 cancelled**. The second run succeeded after the Action runtime upgrades at commit `6d40125`. Its exact count was not independently captured. These are historical results. The public workflow reproduces the build and root-level serial test command, including the fake AWS tests. Docker acceptance is separate. Model-facing tests use scripted responses or provider mocks.

## Scripted Incident Evaluation

The baseline uses five accepted fixture incidents. The expanded dataset retains those five and adds 25 isolated evaluation cases. The scripted model requests service metadata, logs, metrics and one runbook search for each incident, then returns a scripted diagnosis. The application executes the requests through ToolExecutor and MCP. The expanded runner uses existing fixture handlers for the original cases and isolated handlers for the added snapshots. The model receives visible incident fields and delivered tool results. Expected causes and reviewer annotations stay in evaluation.

| Runner | Workflow completion | Cases meeting required-tool criterion | Required tool observations | Automated diagnosis correctness |
| --- | ---: | ---: | ---: | --- |
| Baseline | 5/5 | 5/5 | 20/20 | 5 NOT_EVALUATED |
| Expanded | 30/30 | 30/30 | 85/85 | 30 NOT_EVALUATED |

Completion requires a valid `COMPLETED` record with a schema-valid diagnosis. The coverage criterion checks whether all required tool names appear among recorded logical calls for a case. The aggregate denominator sums each case's required tool count. Retry attempts share a logical call ID. Extra reads are not penalized and the coverage criterion does not score arguments or execution success. Completed records are separately checked for unsuccessful logical calls. The scripted results establish fixture workflow and coverage behavior. Autonomous model selection and diagnosis accuracy require different evidence.

Sources include the [baseline model](../src/evaluation/baseline.ts), [expanded dataset](../src/evaluation/expanded-dataset.ts), [fixture MCP wiring](../src/evaluation/fixture-mcp.ts), [scorer](../src/evaluation/evaluator.ts) and [baseline tests](../test/evaluation.test.js).

## Human-Reviewed Quality Assessment

The following historical aggregates come from the accepted replay of 30 human reviews of saved scripted outcomes. All 30 were assessed for each listed criterion.

| Criterion | PASS | FAIL | Rubric |
| --- | ---: | ---: | --- |
| Tool Correctness | 30/30 | 0/30 | Structural request checks and human Tool Selection must both pass |
| Task Success | 0/30 | 30/30 | Task Success requires a completed workflow and PASS judgments for Cause, Evidence and Actions. |
| Cause | 0/30 | 30/30 | Cause and confidence must follow observed evidence, with uncertainty where warranted |
| Evidence | 0/30 | 30/30 | Diagnostic claims must be supported by outputs actually delivered to the model |
| Actions | 0/30 | 30/30 | Recommendations must follow evidence and uncertainty |
| Tool Selection | 30/30 | 0/30 | Review necessary tools, appropriateness and arguments in context |

The assessor counts PASS and FAIL in the evaluated denominator and tracks NOT_EVALUATED separately. The public source supports new scripted runs and reproduction of the assessment software. Exact replay of these historical decisions requires the original private materials and completed review records. The review set describes the scripted baseline. It provides no population-level estimate for real OpenAI-powered investigations.

Sources include the [rubric](../src/evaluation/quality-contracts.ts), [assessor](../src/evaluation/quality.ts) and [review tests](../test/quality.test.js).

## Measurement and Tracing

The measured runner collects investigation elapsed time and model/tool caller waits. Investigation elapsed includes retry backoff and approval suspension. MCP setup and cleanup sit outside that boundary. Durations depend on the local environment. A timeout records the caller's wait and underlying work can continue.

Scripted model usage is `NOT_AVAILABLE`. The live adapter records usage metadata from observed provider responses when available. The summary distinguishes partial subtotals from complete observed totals. Embedding usage, late work, pricing and billing are outside that accounting. The traced runner demonstrates a single scripted investigation with application-side OpenTelemetry spans retained in memory.

Sources include the [measurement collector](../src/measurement/collector.ts), [summary code](../src/measurement/report.ts), [measured runner](../src/evaluation/measured.ts) and [local tracing setup](../src/tracing/local.ts).

## Single Real-Provider AWS Investigation

One synthetic INC-001 investigation ran as a standalone ECS Fargate task using the real OpenAI Responses adapter. The accepted execution record reports four successful MCP read-tool executions, structured diagnosis verification and successful task termination with container exit code 0. The deployment resources were subsequently cleaned up. Final AWS billing reconciliation remains pending.

The project controller reviewed the diagnosis and recorded PASS based on the supplied AWS investigation report. The original machine-generated `humanDiagnosisQuality=PENDING` field is preserved. No separate structured user adjudication was recorded for this cloud run. These historical observations depend on private evidence. Public source and mock tests reproduce the deployment logic and validation path. A single successful live investigation provides evidence for that execution only.

See the [live session](../src/live-investigation.ts), [AWS template](../deploy/aws/fargate.json) and [run-once verifier](../deploy/aws/run-once.ps1).

## Reproduction Instructions

Run from the repository root with Node.js 22 and npm. Use PowerShell 7 or later on PATH for the complete test suite, including the fake AWS CLI checks. The serial test command below matches the CI test step. The runner commands assume the build has completed.

| Command | Prerequisites and access | Expected output and what it verifies | Evidence boundary |
| --- | --- | --- | --- |
| `npm ci --include=dev --include=optional --no-audit --no-fund` | Node, npm and registry access for uncached packages | Installs locked dependencies including platform-specific optional compiler packages | Installation alone establishes dependency availability |
| `npm run build` | Installed dependencies. Local execution | TypeScript compilation and runnable JavaScript under `dist/` | Build success establishes compilation |
| `node --test --test-concurrency=1 test/*.test.js` | Built project and PowerShell 7. Local execution | Test runner results and summary for root test files, including fake AWS checks | A fresh test run is separate from historical CI and Docker acceptance |
| `node dist/evaluation/run-baseline.js` | Built project. Local execution | Five-case JSON report with completion and required-tool coverage | Scripted workflow and coverage only |
| `node dist/evaluation/run-expanded.js` | Built project. Local execution | Thirty-case JSON report with coverage across isolated fixture snapshots | Scripted workflow and coverage only |
| `node dist/evaluation/run-measured.js` | Built project. Local execution | JSON scoring, timing and usage availability summary with an example investigation | Local waits rather than a provider performance or cost benchmark |
| `node dist/evaluation/run-traced.js` | Built project. Local execution | JSON with one scripted outcome and its in-memory spans | Application-side tracing only |

These commands require no real AWS or OpenAI credentials or paid API calls. Dependency installation may access the package registry. The remaining commands use local code and fixtures. The full quality CLI output includes reviewer-only packets with Ground Truth. Baseline, expanded and measured JSON can also include evaluator-only expected causes. Inspect results locally and share only the intended aggregate fields.

## Interpretation and Limitations

- The automated suites measure software behavior. Test pass counts are independent of AI quality scores.
- Required-tool coverage and Tool Correctness measure different criteria. Both are separate from diagnosis quality.
- The scripted workflows use fixed tool proposals and synthetic data. The single AWS run adds evidence of real-provider execution on one synthetic input.
- Investigation state and tracing are in memory. Measured waits and observed usage are limited to their documented boundaries.

## Evidence and Source References

| Evidence | Provenance | Public reproduction |
| --- | --- | --- |
| Historical CI outcomes | Accepted run results. See the [workflow](../.github/workflows/ci.yml) for commands | Fresh build and offline suite |
| Scripted completion and coverage | [Baseline](../src/evaluation/run-baseline.ts) and [expanded](../src/evaluation/run-expanded.ts) reports | Public fixtures and runners |
| Historical quality totals | Accepted saved review replay. See the [assessment interface](../src/evaluation/quality-contracts.ts) | Public assessor and tests. Exact historical judgments depend on private inputs |
| Measurement and tracing | [Measured](../src/evaluation/run-measured.ts) and [traced](../src/evaluation/run-traced.ts) demonstrations | Public runners with local, variable timings |
| Historical AWS result | Accepted execution record and subsequent controller review. See the [operator guide](../deploy/aws/README.md) | Public configuration and fake CLI tests. Historical live result depends on private evidence |
