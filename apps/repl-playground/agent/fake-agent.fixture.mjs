import process from 'node:process'

import { createInterface } from 'node:readline'

// Test-only ACP peer: expose the received MCP setup so integration tests can
// connect a real MCP client without credentials or an LLM service.
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ id: message.id, jsonrpc: '2.0', result: {
      agentCapabilities: { mcpCapabilities: { http: !process.argv.includes('--no-http') } },
      protocolVersion: 1,
    } })}\n`)
  }
  else if (message.method === 'session/new') {
    process.stdout.write(`${JSON.stringify({ id: message.id, jsonrpc: '2.0', result: {
      _meta: { receivedServers: message.params.mcpServers },
      sessionId: `session-${message.id}`,
    } })}\n`)
  }
})
