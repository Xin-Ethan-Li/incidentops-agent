import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { InvestigationTracing } from './investigation-tracing.js';

/** Offline, isolated, caller-owned SDK lifecycle. No global provider, detectors or network. */
export function createInMemoryTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  return { exporter, provider, tracing: new InvestigationTracing(provider.getTracer('incidentops-agent')) };
}
