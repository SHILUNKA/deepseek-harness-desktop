/**
 * Minimal MCP server over stdio: enough for the manager's tests to observe that
 * a server it mounted really connected and published a tool.
 *
 * Run: node fixture-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'managed-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// The tool name follows an argument, so a test can tell one generation of this
// server from the next: a replacement that never mounted publishes neither.
const toolName = process.argv.includes('--again') ? 'echo2' : 'echo'

server.registerTool(toolName, {
  title: 'Echo',
  description: 'Returns what it was given.',
  inputSchema: { text: z.string().describe('Text to echo') },
}, args => ({ content: [{ type: 'text' as const, text: args.text }] }))

await server.connect(new StdioServerTransport())
