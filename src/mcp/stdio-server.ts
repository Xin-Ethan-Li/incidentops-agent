import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createIncidentOpsServer } from './server.js';
import { RunbookRetriever } from '../rag/runbook-retriever.js';
import { OpenAIEmbeddingProvider } from '../rag/openai-embedding-provider.js';

// stdout belongs exclusively to the MCP transport.
serveStdio(() => createIncidentOpsServer(new RunbookRetriever(new OpenAIEmbeddingProvider())));
