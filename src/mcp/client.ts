import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

/** Caller-owned connection: keep open across approval suspension; close in finally after the terminal outcome. */
export class IncidentOpsMcpClient {
  private readonly client = new Client({ name: 'incidentops-agent', version: '1.0.0' });
  private readonly transport: StdioClientTransport;

  constructor(parameters: StdioServerParameters = {
    command: process.execPath,
    args: [fileURLToPath(new URL('./stdio-server.js', import.meta.url))],
    env: process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {},
  }) { this.transport = new StdioClientTransport(parameters); }

  get pid(): number | null { return this.transport.pid; }
  async connect(options?: Parameters<Client['connect']>[1]): Promise<void> {
    try { await this.client.connect(this.transport, options); }
    catch (error) {
      try { await this.transport.close(); } catch { /* Preserve the initialization failure. */ }
      throw error;
    }
  }
  listTools() { return this.client.listTools(); }
  callTool(params: { name: string; arguments: Record<string, unknown> }) { return this.client.callTool(params); }
  async close(): Promise<void> { await this.client.close(); }
}
