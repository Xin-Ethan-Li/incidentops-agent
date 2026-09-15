import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createIncidentOpsServer } from '../../dist/mcp/server.js';
import { RunbookRetriever } from '../../dist/rag/runbook-retriever.js';
import { runbooks } from '../../dist/fixtures/index.js';

// No credentials or external requests may be used by the local test server.
delete process.env.OPENAI_API_KEY;
globalThis.fetch = () => { throw new Error('External requests forbidden in MCP tests'); };
serveStdio(() => createIncidentOpsServer(new RunbookRetriever({
  async embed(texts) {
    return texts.map(text => text.startsWith('Title:')
      ? (text.includes(runbooks[0].title) ? [1, 0] : [0, 1]) : [1, 0]);
  },
})));
