# IncidentOps Agent

## Overview

IncidentOps Agent investigates synthetic service incidents. For example, if checkout errors rise in a test scenario, it can read logs, check metrics, look up the service and search runbooks before returning a structured diagnosis.

I built it to explore one backend problem: how to let an LLM decide what evidence to gather while the application stays in control of what runs.

## How It Works

The agent runs on Node.js and is written in TypeScript. The live CLI sends a synthetic incident to the OpenAI Responses API. The model proposes tool calls and uses the returned evidence to write a diagnosis.

- **Tool access.** An MCP client talks to a local server over stdio. The live CLI exposes four read tools for logs, metrics, service information and runbooks. Runbook RAG uses semantic search, with keyword matching as a fallback when semantic retrieval is unavailable.
- **Execution limits.** The application checks requests and sets limits on model turns and tool attempts. It bounds caller wait times and allows one retry for a recognized read timeout if budget remains.
- **Approval and output.** In a separate workflow, the orchestrator waits for human approval before a simulated restart. The application checks the final diagnosis format and records tool attempts.

See the [architecture diagrams](docs/architecture.md) for the full flow and the MCP trust boundary.

## Quick Start

Use Node.js 22.14.0 or later and npm. Run these commands from the repository root.

```bash
npm ci --include=dev --include=optional --no-audit --no-fund
npm run build
node dist/evaluation/run-baseline.js
```

Installing packages may need internet access. The demo uses local test data and scripted model responses. It needs no AWS account or OpenAI API key. Expect a JSON report with **5/5** workflows completed and **20/20** required tool observations covered. Share the summary only, since raw output can include evaluator-only expected causes.

## Testing and Evaluation

[GitHub Actions CI #10](https://github.com/Xin-Ethan-Li/incidentops-agent/actions/runs/42528233488) passed **410/410 root offline tests** and **20/20 pilot offline tests**. To run both suites after building, put PowerShell 7 on PATH and use the commands below.

```bash
node --test --test-concurrency=1 test/*.test.js
node --test --test-concurrency=1 test/live-pilot/*.test.js
```

- **Historical scripted evaluation.** The expanded run completed **30/30 workflows** and covered **85/85 required tool observations**. The recorded human review marked Tool Correctness **30/30 PASS** and Task Success **0/30 PASS**.
- **Real-model pilot.** The agent completed **5/5** synthetic investigations using a live OpenAI model. The recorded human review marked Task Success **5/5 PASS** and Tool Correctness **4/5 PASS**. One investigation missed a required runbook lookup.

The five live cases are a small, fixed synthetic evaluation. Their results apply to those cases. See the [evaluation report](docs/evaluation.md) for the rubric and reproduction steps.

## Docker and AWS

The [Docker image](Dockerfile) packages both entry points and runs as a non-root user.

For a local run, build the project and then use one of these npm commands:

- **Health service:** `npm start` starts the NestJS/Fastify app. `GET /health` returns `{"status":"ok"}` on port 3000 by default.
- **Investigation CLI:** `npm run investigate -- --live --incident INC-001` opts in to real provider calls. Set `OPENAI_API_KEY` and `OPENAI_AGENT_MODEL` first. Model and embedding calls can incur charges.

One real OpenAI investigation of synthetic INC-001 completed successfully as an ECS Fargate task. All four MCP read tools succeeded, and the diagnosis passed schema validation. The AWS resources were removed. The result covers one run only. Final AWS billing reconciliation is pending. See the [evaluation report](docs/evaluation.md#single-real-provider-aws-investigation) for review details.

The [AWS operator guide](deploy/aws/README.md) covers deployment and cleanup. CI builds and tests the project. Deployment is an operator task.

## Limits and Documentation

The project uses synthetic incident data and simulates restarts. Investigation state, approvals and OpenTelemetry spans stay in memory. Timeouts limit how long the caller waits, and work may continue after a timeout. The single AWS run shows that one execution worked.

- [Architecture and execution boundaries](docs/architecture.md)
- [Evaluation results and limitations](docs/evaluation.md)
- [AWS deployment guide](deploy/aws/README.md)
- [MIT License](LICENSE)
