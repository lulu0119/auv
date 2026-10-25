import type { AnyMessage } from '@agentclientprotocol/sdk'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { CodeModeHost, codeModeStream, withBriefing } from './codemode-bridge'

const execution = vi.hoisted(() => ({ run: vi.fn(), running: false }))
vi.mock('../../runtime/session', () => ({ session: execution }))
vi.mock('./editor-bridge', () => ({ applyScriptToEditor: vi.fn() }))

describe('codemode browser MCP host', () => {
  it('serves standard MCP before ACP session creation and binds execution to the active session', async () => {
    const host = new CodeModeHost()
    const [agent, page] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'agent', version: '1' })
    await host.connect(page)
    await client.connect(agent)
    try {
      expect((await client.listTools()).tools).toMatchObject([{ name: 'codemode' }])
      expect((await client.callTool({ arguments: { code: 'return 1' }, name: 'codemode' })).isError).toBe(true)
      host.setSession('one')
      execution.run.mockResolvedValueOnce({ codemode: { content: [{ text: 'result', type: 'text' }], store: {} }, status: 'ok' })
      expect(await client.callTool({ arguments: { code: 'text(1)' }, name: 'codemode' })).toMatchObject({ content: [{ text: 'result' }, { text: expect.stringContaining('Script completed') }], isError: false })
      expect(execution.run.mock.lastCall?.[0].codemode.timeoutMs).toBe(30000)
    }
    finally {
      await client.close()
    }
  })

  it('cancels the MCP invocation without affecting calls from another transport', async () => {
    const host = new CodeModeHost()
    host.setSession('one')
    const clients = await Promise.all([1, 2].map(async () => {
      const [agent, page] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'agent', version: '1' })
      await host.connect(page)
      await client.connect(agent)
      return client
    }))
    let finish!: (value: unknown) => void
    execution.run.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const controller = new AbortController()
    const call = clients[0]!.callTool({ arguments: { code: 'await operation()' }, name: 'codemode' }, undefined, { signal: controller.signal })
    const rejection = expect(call).rejects.toThrow()
    try {
      await vi.waitFor(() => expect(execution.run.mock.lastCall?.[0].source).toBe('await operation()'))
      const signal = execution.run.mock.lastCall?.[0].signal as AbortSignal
      await clients[1]!.close()
      expect(signal.aborted).toBe(false)
      controller.abort()
      await rejection
      await vi.waitFor(() => expect(signal.aborted).toBe(true))
      finish({ reason: 'canceled', status: 'stopped' })
    }
    finally {
      await clients[0]!.close()
    }
  })

  it('keeps state in the active session and commits only successful executions', async () => {
    const host = new CodeModeHost()
    host.setSession('one')
    execution.run.mockResolvedValueOnce({ codemode: { content: [{ text: 'selected', type: 'text' }], store: { windowId: 'counter' } }, status: 'ok' })
    expect((await host.execute(1, { code: 'text(1)', sessionId: 'one', timeoutMs: 1000 })).isError).toBe(false)
    execution.run.mockResolvedValueOnce({ codemode: { content: [{ text: 'partial', type: 'text' }], store: { windowId: 'bad' } }, message: 'failed', status: 'error' })
    const failed = await host.execute(2, { code: 'throw 1', sessionId: 'one', timeoutMs: 1000 })
    expect(failed).toMatchObject({ content: [{ text: 'partial' }, { text: 'Script failed: failed' }], isError: true })
    expect(execution.run.mock.lastCall?.[0].codemode.store).toEqual({ windowId: 'counter' })
    host.setSession('two')
    expect((await host.execute(3, { code: 'text(1)', sessionId: 'one', timeoutMs: 1000 })).isError).toBe(true)
    execution.run.mockResolvedValueOnce({ codemode: { content: [], store: {} }, status: 'ok' })
    await host.execute(4, { code: 'text(1)', sessionId: 'two', timeoutMs: 1000 })
    expect(execution.run.mock.lastCall?.[0].codemode.store).toEqual({})
  })

  it('cancels on session replacement and rejects simultaneous calls', async () => {
    const host = new CodeModeHost()
    host.setSession('one')
    let finish!: (value: unknown) => void
    execution.run.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))
    const first = host.execute(1, { code: 'await operation()', sessionId: 'one', timeoutMs: 1000 })
    const signal = execution.run.mock.lastCall?.[0].signal as AbortSignal
    expect((await host.execute(2, { code: 'text(1)', sessionId: 'one', timeoutMs: 1000 })).isError).toBe(true)
    host.cancel('other-request')
    expect(signal.aborted).toBe(false)
    host.setSession('two')
    expect(signal.aborted).toBe(true)
    finish({ codemode: { content: [], store: { stale: true } }, status: 'ok' })
    expect((await first).isError).toBe(true)
  })

  it('distinguishes the host deadline from an explicit cancellation', async () => {
    const host = new CodeModeHost()
    host.setSession('one')
    execution.run.mockResolvedValueOnce({ reason: 'timeout', status: 'stopped' })
    const timeout = await host.execute(1, { code: 'while (true) {}', sessionId: 'one', timeoutMs: 300 })
    expect(timeout.content).toEqual([{ text: 'Script timed out after 300 ms. Delivered inputs are not undone.', type: 'text' }])
    execution.run.mockResolvedValueOnce({ reason: 'canceled', status: 'stopped' })
    const canceled = await host.execute(2, { code: 'await operation()', sessionId: 'one', timeoutMs: 300 })
    expect(canceled.content).toEqual([{ text: 'Script canceled. Delivered inputs are not undone.', type: 'text' }])
  })

  it('passes the Relay HTTP endpoint through ACP and closes it with the connection', async () => {
    const host = new CodeModeHost()
    let incoming!: ReadableStreamDefaultController<AnyMessage>
    const messages: AnyMessage[] = []
    const tools = { close: vi.fn(), closed: new Promise<undefined>(() => {}), headers: [{ name: 'Authorization', value: 'Bearer fixture' }], url: 'https://relay.example/eap/v1/mcp' }
    const support = vi.fn()
    const raw = {
      readable: new ReadableStream<AnyMessage>({ start: controller => void (incoming = controller) }),
      writable: new WritableStream<AnyMessage>({ write: message => void messages.push(message) }),
    }
    const stream = codeModeStream(raw, host, new AbortController().signal, tools, support)
    const reader = stream.readable.getReader()
    const writer = stream.writable.getWriter()
    incoming.enqueue({ id: 1, jsonrpc: '2.0', result: { agentCapabilities: { mcpCapabilities: { http: true } } } })
    await reader.read()
    await writer.write({ id: 2, jsonrpc: '2.0', method: 'session/new', params: { cwd: '/', mcpServers: [] } })
    expect(messages[0]).toMatchObject({ params: { mcpServers: [{ headers: tools.headers, name: 'auv-playground', type: 'http', url: tools.url }] } })
    expect(support).toHaveBeenCalledWith(true)
    incoming.enqueue({ id: 2, jsonrpc: '2.0', result: { sessionId: 'one' } })
    await reader.read()
    execution.run.mockResolvedValueOnce({ codemode: { content: [], store: {} }, status: 'ok' })
    expect((await host.execute(1, { code: 'return 1', sessionId: 'one', timeoutMs: 1000 })).isError).toBe(false)
    incoming.close()
    await reader.read()
    expect(tools.close).toHaveBeenCalled()
  })

  // Briefing state is scoped to the active session on a shared ACP stream.
  it('attaches the sandbox briefing to each session first prompt', async () => {
    const host = new CodeModeHost()
    const replies: AnyMessage[] = []
    const raw = {
      readable: new ReadableStream<AnyMessage>({ start() {} }),
      writable: new WritableStream<AnyMessage>({ write: message => void replies.push(message) }),
    }
    const tools = { close: vi.fn(), closed: new Promise<undefined>(() => {}), headers: [], url: 'https://relay.example/eap/v1/mcp' }
    const stream = codeModeStream(raw, host, new AbortController().signal, tools, () => {}, () => 'briefing')
    const writer = stream.writable.getWriter()
    const prompt = { id: 1, jsonrpc: '2.0' as const, method: 'session/prompt' as const, params: { prompt: [{ text: 'hi', type: 'text' }], sessionId: 'one' } }
    await writer.write(prompt)
    await writer.write({ ...prompt, id: 2 })
    await writer.write({ ...prompt, id: 3, params: { ...prompt.params, sessionId: 'two' } })
    expect(replies[0]).toMatchObject({ params: { prompt: [{ text: 'briefing' }, { text: 'hi' }] } })
    expect(replies[1]).toMatchObject({ params: { prompt: [{ text: 'hi' }] } })
    expect(replies[2]).toMatchObject({ params: { prompt: [{ text: 'briefing' }, { text: 'hi' }], sessionId: 'two' } })
    expect(withBriefing({ jsonrpc: '2.0', method: 'session/list' }, 'briefing')).toMatchObject({ method: 'session/list' })
  })
})
