import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

/** One caller-owned connection. Always close in finally after the investigation. */
export class IncidentOpsMcpClient {
  private readonly client = new Client({ name: 'incidentops-agent', version: '1.0.0' });
  private readonly transport: StdioClientTransport;

  constructor(parameters: StdioServerParameters = {
    command: process.execPath,
    args: [fileURLToPath(new URL('./stdio-server.js', import.meta.url))],
    env: process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {},
  }) { this.transport = new StdioClientTransport(parameters); }

  get pid(): number | null { return this.transport.pid; }
  async connect(): Promise<void> {
    try { await this.client.connect(this.transport); }
    catch (error) { await this.transport.close(); throw error; }
  }
  listTools() { return this.client.listTools(); }
  callTool(params: { name: string; arguments: Record<string, unknown> }) { return this.client.callTool(params); }
  async close(): Promise<void> { await this.client.close(); }
}
