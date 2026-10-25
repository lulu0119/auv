import type { AnyMessage, MessageMcpRequest, MessageMcpResponse, Stream } from '@agentclientprotocol/sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { session } from '../../runtime/session'
import { applyScriptToEditor } from './editor-bridge'

interface CodeCall { code: string, sessionId: string, timeoutMs: number }

const tool = {
  description: 'Execute TypeScript in the connected AUV Playground. Start with text(api.help()). Find SDK methods with text(api.search({query:"window text"})); read signatures, types and examples with text(api.describe({path:"WindowClient.findText"})). Use auv for the selected device, sdk for constants and geometry, text(value) or return for output, await image(capture) for bounded screenshots, and store/load for small JSON state. Each call has fresh variables. Delivered inputs are not rolled back on failure. SDK callbacks and async iterators are not supported yet.',
  inputSchema: {
    additionalProperties: false,
    properties: {
      code: { description: 'Raw TypeScript, with top-level await and return.', maxLength: 100000, minLength: 1, type: 'string' },
      timeoutMs: { default: 30000, maximum: 120000, minimum: 1, type: 'integer' },
    },
    required: ['code'],
    type: 'object',
  },
  name: 'codemode',
}

/** Owns one ACP session's JSON state and the currently executing tool call. */
export class CodeModeHost {
  #active?: { abort: AbortController, id: null | number | string }
  #sessionId?: string
  #store: Record<string, unknown> = {}

  cancel(requestId?: null | number | string): void {
    if (requestId === undefined || this.#active?.id === requestId)
      this.#active?.abort.abort()
  }

  async execute(id: null | number | string, params: unknown): Promise<CallToolResult> {
    const error = (text: string): CallToolResult => ({ content: [{ text, type: 'text' }], isError: true })
    const call = params as Partial<CodeCall> | undefined
    if (!this.#sessionId || call?.sessionId !== this.#sessionId)
      return error('This ACP session is not active in the playground.')
    // NOTICE(codemode-serialization): calls share one mutable desktop. Parallel
    // execution needs an owner-approved ordering contract for delivered input.
    if (this.#active || session.running)
      return error('Another playground execution is running.')
    if (typeof call.code !== 'string' || !call.code.trim() || call.code.length > 100000
      || !Number.isInteger(call.timeoutMs) || call.timeoutMs! < 1 || call.timeoutMs! > 120000) {
      return error('Codemode requires code and a timeoutMs from 1 to 120000.')
    }
    const active = { abort: new AbortController(), id }
    this.#active = active
    try {
      // TODO(codemode-editor-rerun): the editor displays this source for
      // inspection. Manual Run/replay use REPL globals; add VM selection and
      // codemode editor types together in an approved human-debugging slice.
      applyScriptToEditor(call.code)
      const outcome = await session.run({
        codemode: { store: this.#store, timeoutMs: call.timeoutMs! },
        mode: 'run',
        signal: active.abort.signal,
        source: call.code,
        startLine: 1,
      })
      const content = [...(outcome.codemode?.content ?? [])]
      const succeeded = outcome.status === 'ok' && !active.abort.signal.aborted
      if (succeeded && outcome.codemode)
        this.#store = outcome.codemode.store
      // TODO(codemode-result-metadata): typed MCP outcomes require an approved
      // result contract; this interface exposes content and isError.
      content.push({
        text: succeeded
          ? 'Script completed. This confirms execution only; verify the requested external state separately.'
          : outcome.status === 'error'
            ? `Script failed${outcome.line === undefined ? '' : ` at line ${outcome.line}`}: ${outcome.message}`
            : outcome.status === 'stopped' && outcome.reason === 'timeout'
              ? `Script timed out after ${call.timeoutMs} ms. Delivered inputs are not undone.`
              : 'Script canceled. Delivered inputs are not undone.',
        type: 'text',
      })
      return { content, isError: !succeeded }
    }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)) }
    finally {
      if (this.#active === active)
        this.#active = undefined
    }
  }

  setSession(sessionId: string | undefined): void {
    if (sessionId === this.#sessionId)
      return
    this.cancel()
    this.#sessionId = sessionId
    this.#store = {}
  }
}

/**
 * Provides the browser's MCP server over ACP. The UI adapter owns chat;
 * this stream handles the draft MCP binding and its request cancellation.
 */
export function codeModeStream(stream: Stream, host: CodeModeHost, signal: AbortSignal, onSupport: (supported: boolean) => void, briefing?: () => string): Stream {
  const reader = stream.readable.getReader()
  const writer = stream.writable.getWriter()
  let supported = false
  let briefedSessionId: string | undefined
  let registration: undefined | { requestId: null | number | string, serverId: string, sessionId?: string }
  const requests = new Set<null | number | string>()
  const abort = () => host.cancel()
  const dispatch = async (id: null | number | string, call: MessageMcpRequest): Promise<MessageMcpResponse> => {
    const meta = call.params?._meta as Record<string, unknown> | undefined
    if (meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28'
      || !meta['io.modelcontextprotocol/clientCapabilities'] || typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object') {
      throw new Error('MCP-over-ACP requires protocolVersion 2026-07-28 and clientCapabilities in params._meta.')
    }
    if (call.method === 'tools/list')
      return { result: { tools: [tool] } }
    if (call.method === 'ping')
      return { result: {} }
    if (call.method !== 'tools/call')
      return { error: { code: -32601, message: `Unsupported MCP method: ${call.method}` } }
    if (call.params?.name !== tool.name)
      return { error: { code: -32602, message: `Unknown tool: ${String(call.params?.name)}` } }
    const args = call.params.arguments as Partial<CodeCall> | undefined
    // TODO(mcp-progress): codemode returns one final result. Operation-scoped
    // MCP notifications belong to an approved streaming/progress tool slice.
    return { result: await host.execute(id, { ...args, sessionId: registration?.sessionId, timeoutMs: args?.timeoutMs ?? 30000 }) }
  }
  signal.addEventListener('abort', abort, { once: true })
  return {
    readable: new ReadableStream<AnyMessage>({
      async cancel(reason) {
        host.cancel()
        await reader.cancel(reason)
      },
      async start(controller) {
        try {
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            const message = next.value
            if (!('method' in message) && 'result' in message) {
              const result = message.result as { agentCapabilities?: { mcpCapabilities?: { acp?: boolean } }, sessionId?: string }
              if (result?.agentCapabilities) {
                supported = result.agentCapabilities.mcpCapabilities?.acp === true
                onSupport(supported)
              }
              if (registration?.requestId === message.id && result?.sessionId) {
                registration.sessionId = result.sessionId
                host.setSession(result.sessionId)
              }
            }
            if ('method' in message && message.method === 'mcp/message' && 'id' in message) {
              const call = message.params as MessageMcpRequest
              requests.add(message.id)
              const task = supported && registration?.serverId === call?.serverId
                ? dispatch(message.id, call)
                : Promise.reject(new Error('This MCP server is not registered on this connection.'))
              void task.then(
                result => writer.write({ id: message.id, jsonrpc: '2.0', result }),
                error => writer.write({ error: { code: -32602, message: error instanceof Error ? error.message : String(error) }, id: message.id, jsonrpc: '2.0' }),
              ).catch(abort).finally(() => requests.delete(message.id))
            }
            else if ('method' in message && message.method === '$/cancel_request') {
              const params = message.params as undefined | { requestId?: null | number | string }
              // A malformed notification must not cancel another call.
              if (params?.requestId !== undefined && requests.has(params.requestId))
                host.cancel(params.requestId)
              else controller.enqueue(message)
            }
            else {
              controller.enqueue(message)
            }
          }
          controller.close()
        }
        catch (error) { controller.error(error) }
        finally {
          host.cancel()
          signal.removeEventListener('abort', abort)
        }
      },
    }),
    writable: new WritableStream<AnyMessage>({
      abort: (reason) => {
        host.cancel()
        return writer.abort(reason)
      },
      close: () => writer.close(),
      async write(message) {
        if ('method' in message && message.method === 'session/cancel')
          host.cancel()
        let next = message
        if (supported && 'method' in message && message.method === 'session/new' && 'id' in message) {
          registration = { requestId: message.id, serverId: `auv-playground:${crypto.randomUUID()}` }
          host.setSession(undefined)
          const params = message.params as { mcpServers?: unknown[] }
          next = { ...message, params: { ...params, mcpServers: [...(params.mcpServers ?? []), { name: 'auv-playground', serverId: registration.serverId, type: 'acp' }] } }
        }
        if (briefing && 'method' in message && message.method === 'session/prompt') {
          const sessionId = (message.params as undefined | { sessionId?: string })?.sessionId ?? ''
          // New sessions reuse the stream, so the briefing belongs to the
          // active session rather than the connection. The UI never resumes.
          if (briefedSessionId !== sessionId) {
            next = withBriefing(message, briefing())
            if (next !== message)
              briefedSessionId = sessionId
          }
        }
        await writer.write(next)
      },
    }),
  }
}

/** Add environment instructions to the user prompt without a separate agent turn. */
export function withBriefing(message: AnyMessage, briefing: string): AnyMessage {
  if (!('method' in message) || message.method !== 'session/prompt')
    return message
  const params = message.params as undefined | { prompt?: unknown }
  if (!params || !Array.isArray(params.prompt))
    return message
  return { ...message, params: { ...params, prompt: [{ text: briefing, type: 'text' }, ...params.prompt] } }
}
