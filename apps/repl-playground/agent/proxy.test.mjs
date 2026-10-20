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
    if (message.method === '_auv/codemode') {
      const { code, timeoutMs } = message.params
      const outcome = await runCodeMode({
        ...compileCell(code, { allowReturn: true }),
        breakpoints: [],
        codemode: { store: {}, timeoutMs },
        executionId: 1,
        mode: 'run',
      }, { __bind: () => {}, __step: async () => {}, __stepSync: () => {} }, new AbortController().signal)
      send({ id: message.id, jsonrpc: '2.0', result: { content: outcome.codemode.content, isError: outcome.status !== 'ok' } })
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
  return { incoming, request }
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
    const initialized = await peer.request('initialize', { clientCapabilities: { _meta: { auv: { codemode: 1 } } }, protocolVersion: 1 })
    expect(initialized.result.agentCapabilities._meta.auv.codemode).toBe(1)
    const created = await peer.request('session/new', { cwd: '/', mcpServers: [] })
    const server = created.result._meta.receivedServers[0]
    expect(server.type).toBe('http')
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    const client = new Client({ name: 'test', version: '1' })
    cleanup.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }))
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['codemode'])
    const result = await client.callTool({ arguments: { code: 'const values = [1, 2, 3]; return values.reduce((a, b) => a + b, 0);' }, name: 'codemode' })
    expect(result).toMatchObject({ content: [{ text: '6', type: 'text' }], isError: false })
    const reverse = peer.incoming.find(message => message.method === '_auv/codemode')
    expect(reverse.params.sessionId).toBe(created.result.sessionId)
    const other = await peer.request('session/new', { cwd: '/', mcpServers: [] })
    expect(other.result._meta.receivedServers[0].url).not.toBe(server.url)
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(404)
  })

  it('keeps unwrapped clients unchanged and rejects agents without HTTP MCP support', async () => {
    const peer = await connection(['--no-http'])
    await peer.request('initialize', { clientCapabilities: {}, protocolVersion: 1 })
    const plain = await peer.request('session/new', { cwd: '/', mcpServers: [] })
    expect(plain.result._meta.receivedServers).toEqual([])
    await peer.request('initialize', { clientCapabilities: { _meta: { auv: { codemode: 1 } } }, protocolVersion: 1 })
    const unsupported = await peer.request('session/new', { cwd: '/', mcpServers: [] })
    expect(unsupported.error.message).toContain('HTTP MCP')
  })
})
