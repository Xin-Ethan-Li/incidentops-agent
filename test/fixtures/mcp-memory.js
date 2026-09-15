import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createIncidentOpsServer } from '../../dist/mcp/server.js';
import { ToolExecutor } from '../../dist/agent/tool-executor.js';

// Focused tests use the same SDK server/handlers without a process per case.
export async function createTestExecutor(t, retriever) {
  const server = createIncidentOpsServer(retriever);
  const client = new Client({ name: 'focused-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return new ToolExecutor(client);
}
