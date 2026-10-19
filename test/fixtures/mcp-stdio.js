import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { IncidentOpsMcpClient } from '../../dist/mcp/client.js';

// Caller owns the connection, including while an investigation awaits approval.
export async function connectTestMcpClient(t) {
  const client = new IncidentOpsMcpClient({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-stdio-server.js', import.meta.url))], env: {} });
  let pid;
  t.after(async () => {
    await client.close();
    if (pid) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'MCP child must exit after close');
  });
  await client.connect();
  pid = client.pid;
  assert.ok(Number.isInteger(pid) && pid !== process.pid, 'Separate Node child process');
  return client;
}
