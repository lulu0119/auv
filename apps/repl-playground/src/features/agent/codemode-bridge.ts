import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { session } from '../../runtime/session'
import { applyScriptToEditor } from './editor-bridge'

interface CodeCall { code: string, sessionId: string, timeoutMs: number }

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
            : 'Script stopped or timed out. Delivered inputs are not undone.',
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
 * Filters app-owned reverse tool requests before the ordinary ACP SDK sees
 * them. All standard protocol traffic keeps the existing SDK adapter.
 */
export function codeModeStream(stream: Stream, host: CodeModeHost, signal: AbortSignal, onSupport: (supported: boolean) => void, briefing?: () => string): Stream {
  const reader = stream.readable.getReader()
  const writer = stream.writable.getWriter()
  let supported = false
  let briefedSessionId: string | undefined
  const abort = () => host.cancel()
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
              const result = message.result as { agentCapabilities?: { _meta?: { auv?: { codemode?: number } } } }
              if (result?.agentCapabilities) {
                supported = result.agentCapabilities._meta?.auv?.codemode === 1
                onSupport(supported)
              }
            }
            if ('method' in message && message.method === '_auv/codemode' && 'id' in message) {
              const task = supported
                ? host.execute(message.id, message.params)
                : Promise.resolve({ content: [{ text: 'Codemode was not negotiated.', type: 'text' }], isError: true })
              void task.then(result => writer.write({ id: message.id, jsonrpc: '2.0', result })).catch(abort)
            }
            else if ('method' in message && message.method === '_auv/codemode/cancel') {
              const params = message.params as undefined | { requestId?: null | number | string }
              // A malformed notification must not cancel another call.
              if (params?.requestId !== undefined)
                host.cancel(params.requestId)
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
