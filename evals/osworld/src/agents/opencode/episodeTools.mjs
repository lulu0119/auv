import process from 'node:process'

// MCP stdio server with the episode-ending `done` and `fail` tools.
//
// They belong to the eval, not to AUV: OSWorld scores infeasible tasks by
// `FAIL`. The opencode harness serves them next to AUV and reads the
// decision from `OSWORLD_EPISODE_DECISION_FILE` after the run. The tool
// descriptions match `episodeTools` in `src/agent.ts`.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const decisionFile = process.env.OSWORLD_EPISODE_DECISION_FILE
const emptyInput = { additionalProperties: false, properties: {}, type: 'object' }
const tools = [
  { description: 'Call when the task is complete. Ends the episode.', inputSchema: emptyInput, name: 'done' },
  { description: 'Call when the task cannot be completed on this computer: the request is impossible, contradicts itself, or needs a feature, file, or setting the application does not have. Ends the episode.', inputSchema: emptyInput, name: 'fail' },
]

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

createInterface({ crlfDelay: Infinity, input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) {
    return
  }
  switch (request.method) {
    case 'initialize':
      send({ id: request.id, result: { capabilities: { tools: {} }, protocolVersion: request.params.protocolVersion, serverInfo: { name: 'osworld', version: '1' } } })
      return
    case 'tools/call': {
      const action = request.params?.name === 'done' ? 'DONE' : request.params?.name === 'fail' ? 'FAIL' : undefined
      if (action == null) {
        send({ error: { code: -32602, message: `unknown tool: ${String(request.params?.name)}` }, id: request.id })
        return
      }
      // The first decision ends the episode; later calls cannot change it.
      try {
        writeFileSync(decisionFile, JSON.stringify({ action, time: Date.now() }), { flag: 'wx' })
      }
      catch {}
      send({ id: request.id, result: { content: [{ text: 'Episode ended. Stop now; do not call any more tools.', type: 'text' }] } })
      return
    }
    case 'tools/list':
      send({ id: request.id, result: { tools } })
      return
    default:
      send({ error: { code: -32601, message: `method not found: ${request.method}` }, id: request.id })
  }
})
