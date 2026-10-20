import process from 'node:process'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * App-owned ACP adapter. Standard HTTP MCP on the agent host becomes an
 * opt-in reverse request on the browser's existing ACP connection.
 * Exterior can run this command as an ordinary custom agent slot.
 */
export async function startProxy({ args, command, input = process.stdin, output = process.stdout }) {
  let finishProcess
  const finished = new Promise((resolve) => {
    finishProcess = resolve
  })
  const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  let spawnError
  child.once('error', (error) => {
    spawnError = error
  })
  const token = randomUUID()
  const sessions = new Map()
  // TODO(codemode-session-release): endpoints live until process exit;
  // earlier release requires an approved ACP session-close contract.
  const creating = new Map()
  const pending = new Map()
  const transports = new Set()
  let optedIn = false
  let httpSupported = false
  let closed = false
  const send = message => output.writable && output.write(`${JSON.stringify(message)}\n`)
  const forward = message => child.stdin.write(`${JSON.stringify(message)}\n`)

  const http = createServer(async (request, response) => {
    const session = sessions.get(request.url)
    if (!session || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end()
      return
    }
    // Stateless POST-only MCP: each request has its own SDK transport. The
    // ACP session, rather than an HTTP session, owns the browser execution.
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const server = new Server({ name: 'auv-playground', version: '0.0.34' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      description: 'Execute TypeScript in the connected AUV Playground. Start with text(api.help()) for usage. Find SDK methods with text(api.search({query:"window text"})); get exact signatures, argument/return types and examples with text(api.describe({path:"WindowClient.findText"})). Pass a related type name to api.describe for more detail. Use auv for the selected device, sdk for constants and geometry, text(value) or return for output, await image(capture) for bounded screenshots, and store/load for small JSON state. Calls have fresh variables. Only explicit output returns. Delivered inputs are not rolled back on failure. SDK callbacks and async iterators are not supported yet.',
      inputSchema: {
        additionalProperties: false,
        properties: {
          code: { description: 'Raw TypeScript, with top-level await and return.', type: 'string' },
          timeoutMs: { default: 30000, maximum: 120000, minimum: 1, type: 'integer' },
        },
        required: ['code'],
        type: 'object',
      },
      name: 'codemode',
    }] }))
    server.setRequestHandler(CallToolRequestSchema, async (call, context) => {
      const { code, timeoutMs = 30000 } = call.params.arguments ?? {}
      if (call.params.name !== 'codemode' || typeof code !== 'string' || !code.trim() || code.length > 100000
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !session.id) {
        return { content: [{ text: 'Invalid codemode arguments or ACP session is not ready.', type: 'text' }], isError: true }
      }
      const id = `auv-codemode:${randomUUID()}`
      return await new Promise((resolve) => {
        const cancel = () => {
          send({ jsonrpc: '2.0', method: '_auv/codemode/cancel', params: { requestId: id, sessionId: session.id } })
          finish({ content: [{ text: 'Codemode canceled or its connection timed out. Delivered inputs are not undone.', type: 'text' }], isError: true })
        }
        const timer = setTimeout(cancel, timeoutMs + 10000)
        function finish(result) {
          if (!pending.delete(id))
            return
          clearTimeout(timer)
          context.signal.removeEventListener('abort', cancel)
          resolve(result)
        }
        pending.set(id, { cancel, finish, sessionId: session.id })
        context.signal.addEventListener('abort', cancel, { once: true })
        if (context.signal.aborted)
          cancel()
        else send({ id, jsonrpc: '2.0', method: '_auv/codemode', params: { code, sessionId: session.id, timeoutMs } })
      })
    })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined })
    transports.add(transport)
    response.on('close', () => {
      transports.delete(transport)
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response)
    }
    catch (error) {
      console.error(error)
      if (!response.headersSent)
        response.writeHead(500).end()
    }
  })
  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', resolve)
  })
  if (spawnError) {
    http.close()
    throw spawnError
  }
  const endpoint = `http://127.0.0.1:${http.address().port}`

  const browserLines = createInterface({ input })
  const agentLines = createInterface({ input: child.stdout })
  browserLines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      const waiting = pending.get(message.id)
      if (waiting && !message.method) {
        waiting.finish(message.result ?? { content: [{ text: message.error?.message ?? 'Playground execution failed.', type: 'text' }], isError: true })
        return
      }
      if (message.method === 'initialize')
        optedIn = message.params?.clientCapabilities?._meta?.auv?.codemode === 1
      if (message.method === 'session/new' && optedIn) {
        if (!httpSupported) {
          send({ error: { code: -32602, message: 'Playground codemode requires an ACP agent with HTTP MCP support.' }, id: message.id, jsonrpc: '2.0' })
          return
        }
        const path = `/mcp/${randomUUID()}`
        const session = {}
        sessions.set(path, session)
        creating.set(message.id, session)
        message.params.mcpServers = [...(message.params.mcpServers ?? []), {
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
          name: 'auv-playground',
          type: 'http',
          url: endpoint + path,
        }]
      }
      if (message.method === 'session/cancel') {
        for (const call of pending.values()) {
          if (call.sessionId === message.params?.sessionId)
            call.cancel()
        }
      }
      forward(message)
    }
    catch (error) { console.error('Invalid browser ACP frame:', error.message) }
  })
  agentLines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      const session = creating.get(message.id)
      if (session && !message.method) {
        session.id = message.result?.sessionId
        creating.delete(message.id)
      }
      if (message.result?.agentCapabilities) {
        httpSupported = message.result.agentCapabilities.mcpCapabilities?.http === true
        if (optedIn && httpSupported) {
          message.result.agentCapabilities._meta = { ...message.result.agentCapabilities._meta, auv: { codemode: 1 } }
        }
      }
      send(message)
    }
    catch (error) { console.error('Invalid agent ACP frame:', error.message) }
  })
  const close = () => {
    if (closed)
      return
    closed = true
    for (const call of pending.values()) call.cancel()
    browserLines.close()
    agentLines.close()
    child.kill()
    for (const transport of transports) void transport.close()
    http.closeAllConnections()
    http.close()
  }
  browserLines.on('close', close)
  child.once('error', (error) => {
    console.error(error)
    finishProcess(1)
    close()
  })
  child.once('exit', (code) => {
    finishProcess(code ?? 0)
    close()
  })
  return { close, finished }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [separator, command, ...args] = process.argv.slice(2)
  if (separator !== '--' || !command) {
    console.error('Usage: node agent/proxy.mjs -- <ACP executable> [arguments]')
    process.exitCode = 1
  }
  else {
    void startProxy({ args, command }).then((proxy) => {
      process.once('SIGINT', proxy.close)
      process.once('SIGTERM', proxy.close)
      void proxy.finished.then((code) => {
        process.exitCode = code
      })
    }).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
