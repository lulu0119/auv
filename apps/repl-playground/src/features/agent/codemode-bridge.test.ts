import type { AnyMessage } from '@agentclientprotocol/sdk'

import { describe, expect, it, vi } from 'vitest'

import { CodeModeHost, codeModeStream, withBriefing } from './codemode-bridge'

const execution = vi.hoisted(() => ({ run: vi.fn(), running: false }))
vi.mock('../../runtime/session', () => ({ session: execution }))
vi.mock('./editor-bridge', () => ({ applyScriptToEditor: vi.fn() }))

describe('codemode ACP browser host', () => {
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

  it('handles reverse requests without putting them in the normal ACP transcript', async () => {
    const host = new CodeModeHost()
    host.setSession('one')
    execution.run.mockResolvedValueOnce({ codemode: { content: [{ text: 'result', type: 'text' }], store: {} }, status: 'ok' })
    let incoming!: ReadableStreamDefaultController<AnyMessage>
    const replies: AnyMessage[] = []
    const support = vi.fn()
    const raw = {
      readable: new ReadableStream<AnyMessage>({ start: (controller) => { incoming = controller } }),
      writable: new WritableStream<AnyMessage>({ write: (message) => { replies.push(message) } }),
    }
    const stream = codeModeStream(raw, host, new AbortController().signal, support)
    const reader = stream.readable.getReader()
    incoming.enqueue({ id: 1, jsonrpc: '2.0', result: { agentCapabilities: { mcpCapabilities: { acp: true } } } })
    expect((await reader.read()).value).toMatchObject({ id: 1 })
    const writer = stream.writable.getWriter()
    await writer.write({ id: 2, jsonrpc: '2.0', method: 'session/new', params: { cwd: '/', mcpServers: [] } })
    const declaration = (replies[0] as { params: { mcpServers: Array<{ serverId: string, type: string }> } }).params.mcpServers[0]!
    expect(declaration.type).toBe('acp')
    incoming.enqueue({ id: 2, jsonrpc: '2.0', result: { sessionId: 'one' } })
    await reader.read()
    incoming.enqueue({ id: 'code-call', jsonrpc: '2.0', method: 'mcp/message', params: {
      method: 'tools/call',
      params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }, arguments: { code: 'text(1)', timeoutMs: 1000 }, name: 'codemode' },
      requestId: 'logical-id',
      serverId: declaration.serverId,
    } })
    incoming.enqueue({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'one' } })
    expect((await reader.read()).value).toMatchObject({ method: 'session/update' })
    await vi.waitFor(() => expect(replies[1]).toMatchObject({ id: 'code-call', result: { result: { content: [{ text: 'result' }, { text: expect.stringContaining('Script completed') }], isError: false } } }))
    expect(support).toHaveBeenCalledWith(true)
    const call = { method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }, requestId: 'catalog', serverId: declaration.serverId }
    incoming.enqueue({ id: 'catalog', jsonrpc: '2.0', method: 'mcp/message', params: call })
    incoming.enqueue({ id: 'bad-server', jsonrpc: '2.0', method: 'mcp/message', params: { ...call, serverId: 'not-registered' } })
    incoming.enqueue({ id: 'bad-metadata', jsonrpc: '2.0', method: 'mcp/message', params: { ...call, params: {} } })
    incoming.enqueue({ id: 'bad-method', jsonrpc: '2.0', method: 'mcp/message', params: { ...call, method: 'no-such-method' } })
    await vi.waitFor(() => expect(replies).toHaveLength(6))
    expect(replies.find(reply => 'id' in reply && reply.id === 'catalog')).toMatchObject({ result: { result: { tools: [{ name: 'codemode' }] } } })
    expect(replies.find(reply => 'id' in reply && reply.id === 'bad-server')).toMatchObject({ error: { code: -32602 } })
    expect(replies.find(reply => 'id' in reply && reply.id === 'bad-metadata')).toMatchObject({ error: { code: -32602 } })
    expect(replies.find(reply => 'id' in reply && reply.id === 'bad-method')).toMatchObject({ result: { error: { code: -32601 } } })
    // Cancellation of another ACP service still belongs to the UI SDK.
    incoming.enqueue({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'permission-call' } })
    expect((await reader.read()).value).toMatchObject({ method: '$/cancel_request' })
    incoming.close()
    await reader.read()
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

  // Briefing state is scoped to the active session on a shared ACP stream.
  it('attaches the sandbox briefing to each session first prompt', async () => {
    const host = new CodeModeHost()
    const replies: AnyMessage[] = []
    const raw = {
      readable: new ReadableStream<AnyMessage>({ start() {} }),
      writable: new WritableStream<AnyMessage>({ write: message => void replies.push(message) }),
    }
    const stream = codeModeStream(raw, host, new AbortController().signal, () => {}, () => 'briefing')
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
