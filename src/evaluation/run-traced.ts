import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import { InvestigationMeasurements } from '../measurement/collector.js';
import { createInMemoryTracing } from '../tracing/local.js';
import { createScriptedBaselineModel } from './baseline.js';
import { toAgentIncident } from './cases.js';
import { createExpandedDataset } from './expanded-dataset.js';
import { connectScenarioExecutor } from './fixture-mcp.js';

// Optional one-case offline inspection: node dist/evaluation/run-traced.js
const local = createInMemoryTracing();
try {
  const scenario = createExpandedDataset()[0];
  const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
  try {
    const measurements = new InvestigationMeasurements();
    const agent = new AgentOrchestrator(createScriptedBaselineModel(), connection.executor, 8, 8, 30_000, 30_000, measurements, local.tracing);
    const result = await agent.investigate(toAgentIncident(scenario.evaluationCase));
    await local.provider.forceFlush();
    console.log(JSON.stringify({ execution: 'One scripted investigation; offline in-memory SDK; application-side MCP waits only',
      outcome: result.status, traceComplete: result.status !== 'AWAITING_APPROVAL',
      spans: local.exporter.getFinishedSpans().map(span => ({ name: span.name, ...span.spanContext(),
        parentSpanId: span.parentSpanContext?.spanId ?? null, status: span.status, attributes: span.attributes,
        events: span.events, duration: span.duration })),
      limitations: 'Root elapsed includes backoff/approval waiting. Not active time, real LLM latency, production performance or distributed MCP tracing. No persisted traces or invented usage.' }, null, 2));
  } finally { await connection.close(); }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await local.provider.shutdown(); }
