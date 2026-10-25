import process from 'node:process'

import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'

import { compileCell } from '../src/stepper/compile'
import { runCodeMode } from '../src/workers/codemode'
import { startProxy } from './proxy.mjs'

const cleanup = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function connection(extraArgs = []) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = createInterface({ input: output })
  const waiters = new Map()
  const incoming = []
  let serial = 0
  const send = message => input.write(`${JSON.stringify(message)}\n`)
  lines.on('line', async (line) => {
    const message = JSON.parse(line)
    incoming.push(message)
    if (message.method === 'mcp/message') {
      const { method, params } = message.params
      if (method === 'tools/list') {
        send({ id: message.id, jsonrpc: '2.0', result: { result: { tools: [{ inputSchema: { type: 'object' }, name: 'codemode' }] } } })
        return
      }
      if (params.arguments?.code === 'mcp-error') {
        send({ id: message.id, jsonrpc: '2.0', result: { error: { code: -32000, data: null, extension: { kept: true }, message: 'MCP failure' } } })
        return
      }
      if (params.arguments?.code === 'wait')
        return
      const { code, timeoutMs = 30000 } = params.arguments
      const outcome = await runCodeMode({
        ...compileCell(code, { allowReturn: true, recordOnly: true }),
        breakpoints: [],
        codemode: { store: {}, timeoutMs },
        executionId: 1,
        mode: 'run',
      }, { __bind: () => {}, __step: async () => {}, __stepSync: () => {} }, new AbortController().signal)
      send({ id: message.id, jsonrpc: '2.0', result: { result: { content: outcome.codemode.content, isError: outcome.status !== 'ok' } } })
    }
    else if (!message.method && waiters.has(message.id)) {
      waiters.get(message.id)(message)
      waiters.delete(message.id)
    }
  })
  const proxy = await startProxy({ args: [fileURLToPath(new URL('./fake-agent.fixture.mjs', import.meta.url)), ...extraArgs], command: process.execPath, input, output })
  cleanup.push(() => {
    proxy.close()
    lines.close()
    input.destroy()
    output.destroy()
  })
  const request = (method, params) => new Promise((resolve) => {
    const id = ++serial
    waiters.set(id, resolve)
    send({ id, jsonrpc: '2.0', method, params })
  })
  return { incoming, request, send }
}

describe('codemode ACP proxy', () => {
  it('preserves the ACP executable exit status', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const proxy = await startProxy({ args: ['-e', 'process.exit(7)'], command: process.execPath, input, output })
    expect(await proxy.finished).toBe(7)
    input.destroy()
    output.destroy()
  })

  it('injects MCP per session and round-trips a real MCP code call over ACP', async () => {
    const peer = await connection()
    const initialized = await peer.request('initialize', { clientCapabilities: {}, protocolVersion: 1 })
    expect(initialized.result.agentCapabilities.mcpCapabilities.acp).toBe(true)
    const created = await peer.request('session/new', { cwd: '/', mcpServers: [{ name: 'provider', serverId: 'server-one', type: 'acp' }] })
    const server = created.result._meta.receivedServers[0]
    expect(server.type).toBe('http')
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    const client = new Client({ name: 'test', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['codemode'])
    const result = await client.callTool({ arguments: { code: 'const values = [1, 2, 3]; return values.reduce((a, b) => a + b, 0);' }, name: 'codemode' })
    expect(result).toMatchObject({ content: [{ text: '6', type: 'text' }], isError: false })
    const reverse = peer.incoming.find(message => message.method === 'mcp/message')
    expect(reverse.params).toMatchObject({ method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }, serverId: 'server-one' })
    const other = await peer.request('session/new', { cwd: '/', mcpServers: [{ name: 'provider', serverId: 'server-two', type: 'acp' }] })
    expect(other.result._meta.receivedServers[0].url).not.toBe(server.url)
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(404)
    const error = await fetch(server.url, { body: JSON.stringify({ id: 'external-id', jsonrpc: '2.0', method: 'tools/call', params: { arguments: { code: 'mcp-error' }, name: 'codemode' } }), headers: { ...Object.fromEntries(server.headers.map(header => [header.name, header.value])), 'Content-Type': 'application/json' }, method: 'POST' })
    expect(await error.json()).toEqual({ error: { code: -32000, data: null, extension: { kept: true }, message: 'MCP failure' }, id: 'external-id', jsonrpc: '2.0' })
    const abort = new AbortController()
    const waiting = client.callTool({ arguments: { code: 'wait' }, name: 'codemode' }, undefined, { signal: abort.signal })
    await expect.poll(() => peer.incoming.some(message => message.params?.params?.arguments?.code === 'wait')).toBe(true)
    const operation = peer.incoming.find(message => message.params?.params?.arguments?.code === 'wait')
    abort.abort()
    await expect(waiting).rejects.toThrow()
    await expect.poll(() => peer.incoming.some(message => message.method === '$/cancel_request' && message.params.requestId === operation.id)).toBe(true)
    peer.send({ id: operation.id, jsonrpc: '2.0', result: { result: { content: [], isError: true } } })
    await peer.request('session/new', { cwd: '/', mcpServers: [] })
    expect(peer.incoming.some(message => message.method === 'test/unexpected-response')).toBe(false)
    expect((await client.listTools()).tools[0].name).toBe('codemode')
  })

  it('keeps unwrapped clients unchanged and rejects agents without HTTP MCP support', async () => {
    const peer = await connection(['--no-http'])
    await peer.request('initialize', { clientCapabilities: {}, protocolVersion: 1 })
    const plain = await peer.request('session/new', { cwd: '/', mcpServers: [] })
    expect(plain.result._meta.receivedServers).toEqual([])
    const unsupported = await peer.request('session/new', { cwd: '/', mcpServers: [{ name: 'provider', serverId: 'one', type: 'acp' }] })
    expect(unsupported.error.message).toContain('HTTP MCP')
  })

  it('leaves native ACP MCP declarations unchanged', async () => {
    const peer = await connection(['--native'])
    await peer.request('initialize', { protocolVersion: 1 })
    const declarations = [{ name: 'native', serverId: 'native-one', type: 'acp' }]
    const created = await peer.request('session/new', { cwd: '/', mcpServers: declarations })
    expect(created.result._meta.receivedServers).toEqual(declarations)
  })
})
