import process from 'node:process'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'

/** Adapt ACP MCP tool servers for HTTP-only agents. Native agents pass through. */
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
  // TODO(mcp-registration-release): routes live until connection shutdown;
  // earlier removal needs the agent's explicit session/registration lifecycle.
  const servers = new Map()
  const pending = new Map()
  let nativeSupported = false
  let httpSupported = false
  let closed = false
  const send = message => output.writable && output.write(`${JSON.stringify(message)}\n`)
  const forward = message => child.stdin.write(`${JSON.stringify(message)}\n`)

  const http = createServer(async (request, response) => {
    const server = servers.get(request.url)
    if (!server || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const reply = (id, outcome) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id, jsonrpc: '2.0', ...outcome }))
    try {
      request.setEncoding('utf8')
      let body = ''
      for await (const part of request) {
        body += part
        if (body.length > 1048576) {
          response.writeHead(413).end()
          return
        }
      }
      const message = JSON.parse(body)
      if (message.method === 'initialize') {
        // NOTICE(legacy-http-mcp): current OpenCode initializes a standalone
        // HTTP MCP client. Terminate that handshake here; native ACP operations
        // use request-scoped 2026-07-28 metadata and have no initialize exchange.
        // Remove this adapter when the agent advertises mcpCapabilities.acp.
        server.capabilities = message.params?.capabilities ?? {}
        reply(message.id, { result: {
          capabilities: { tools: {} },
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(message.params?.protocolVersion) ? message.params.protocolVersion : LATEST_PROTOCOL_VERSION,
          serverInfo: { name: server.name, version: '1' },
        } })
        return
      }
      if (!('id' in message)) {
        if (message.method === 'notifications/cancelled') {
          for (const call of pending.values()) {
            if (call.serverId === server.serverId && call.httpId === message.params?.requestId)
              call.cancel()
          }
        }
        response.writeHead(202).end()
        return
      }
      const id = `mcp:${randomUUID()}`
      let canceled = false
      const cancel = () => {
        if (canceled || !pending.has(id))
          return
        canceled = true
        send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } })
        if (!response.destroyed)
          reply(message.id, { error: { code: -32800, message: 'MCP operation canceled.' } })
      }
      response.once('close', cancel)
      pending.set(id, {
        cancel,
        finish(outcome) {
          pending.delete(id)
          response.removeListener('close', cancel)
          // A canceled operation still owns its terminal ACP response. Do not
          // forward that late response to the wrapped agent's request table.
          if (!canceled)
            reply(message.id, outcome)
        },
        httpId: message.id,
        serverId: server.serverId,
      })
      send({ id, jsonrpc: '2.0', method: 'mcp/message', params: {
        method: message.method,
        params: { ...message.params, _meta: {
          ...message.params?._meta,
          'io.modelcontextprotocol/clientCapabilities': server.capabilities,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        } },
        requestId: randomUUID(),
        serverId: server.serverId,
      } })
    }
    catch (error) {
      if (!response.headersSent)
        response.writeHead(400).end(JSON.stringify({ error: String(error) }))
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
        // Inner MCP errors keep their code, data and extensions. An outer ACP
        // failure is a binding failure, never an MCP authentication outcome.
        waiting.finish(message.error
          ? { error: { code: -32603, data: { acpError: message.error }, message: message.error.message } }
          : message.result)
        return
      }
      if (['session/load', 'session/new', 'session/resume'].includes(message.method) && !nativeSupported) {
        const declarations = message.params?.mcpServers ?? []
        if (declarations.some(server => server.type === 'acp') && !httpSupported) {
          send({ error: { code: -32602, message: 'The agent supports neither native ACP MCP nor HTTP MCP.' }, id: message.id, jsonrpc: '2.0' })
          return
        }
        message.params.mcpServers = declarations.map((server) => {
          if (server.type !== 'acp')
            return server
          const path = `/mcp/${encodeURIComponent(server.serverId)}`
          servers.set(path, { ...server, capabilities: {} })
          return { ...server, headers: [{ name: 'Authorization', value: `Bearer ${token}` }], serverId: undefined, type: 'http', url: endpoint + path }
        })
      }
      forward(message)
    }
    catch (error) { console.error('Invalid client ACP frame:', error.message) }
  })
  agentLines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.result?.agentCapabilities) {
        const capabilities = message.result.agentCapabilities
        nativeSupported = capabilities.mcpCapabilities?.acp === true
        httpSupported = capabilities.mcpCapabilities?.http === true
        if (!nativeSupported && httpSupported)
          capabilities.mcpCapabilities.acp = true
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
