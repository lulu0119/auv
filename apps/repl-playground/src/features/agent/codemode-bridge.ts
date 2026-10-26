import type { ServedMcp } from '@exterioragentprotocol/sdk/client'
import type { AcpClientConnection } from '@hafbit/react-acp/core'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

import { version } from '../../../package.json'
import { session } from '../../runtime/session'
import { applyScriptToEditor } from './editor-bridge'

const tool = {
  description: 'Execute TypeScript in the connected AUV Playground. Call codemode sequentially, including help queries. Wait for each tool result before starting the next call. Start with text(api.help()). Find SDK methods with text(api.search({query:"window text"})); read signatures, types and examples with text(api.describe({path:"WindowClient.findText"})). Use auv for the selected device, sdk for constants and geometry, text(value) or return for output, await image(capture) for bounded screenshots, and store/load for small JSON state. Each call has fresh variables. Delivered inputs are not rolled back on failure. SDK callbacks and async iterators are not supported yet.',
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
  #active?: AbortController
  #sessionId?: string
  #store: Record<string, unknown> = {}

  cancel(): void {
    this.#active?.abort()
  }

  /** Each Relay MCP session gets its own protocol connection to this execution host. */
  async connect(transport: Transport): Promise<void> {
    const server = new Server({ name: 'auv-playground', version }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool] }))
    server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
      if (request.params.name !== tool.name)
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`)
      // TODO(mcp-progress): operation-scoped notifications belong to an
      // approved streaming/progress tool slice. Return one final result.
      return this.#execute(request.params.arguments, signal)
    })
    await server.connect(transport)
  }

  setSession(sessionId: string | undefined): void {
    if (sessionId === this.#sessionId)
      return
    this.cancel()
    this.#sessionId = sessionId
    this.#store = {}
  }

  async #execute(params: Record<string, unknown> | undefined, requestSignal: AbortSignal): Promise<CallToolResult> {
    const error = (text: string): CallToolResult => ({ content: [{ text, type: 'text' }], isError: true })
    if (!this.#sessionId)
      return error('This ACP session is not active in the playground.')
    // NOTICE(codemode-serialization): calls share one mutable desktop. Parallel
    // execution needs an owner-approved ordering contract for delivered input.
    if (this.#active || session.running)
      return error('Another playground execution is running.')
    const code = params?.code
    const timeoutMs = params?.timeoutMs ?? 30000
    if (typeof code !== 'string' || !code.trim() || code.length > 100000
      || typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      return error('Codemode requires code and a timeoutMs from 1 to 120000.')
    }
    const active = new AbortController()
    this.#active = active
    // Each MCP request carries its own signal, including across transports.
    const signal = AbortSignal.any([active.signal, requestSignal])
    try {
      signal.throwIfAborted()
      // TODO(codemode-editor-rerun): the editor displays this source for
      // inspection. Manual Run/replay use REPL globals; add VM selection and
      // codemode editor types together in an approved human-debugging slice.
      applyScriptToEditor(code)
      const outcome = await session.run({
        codemode: { store: this.#store, timeoutMs },
        mode: 'run',
        signal,
        source: code,
        startLine: 1,
      })
      const content = [...(outcome.codemode?.content ?? [])]
      const succeeded = outcome.status === 'ok' && !signal.aborted
      if (succeeded && outcome.codemode)
        this.#store = outcome.codemode.store
      // TODO(codemode-result-metadata): typed MCP outcomes require an approved
      // result contract; this interface exposes content and isError.
      let text = 'Script canceled. Delivered inputs are not undone.'
      if (succeeded)
        text = 'Script completed. This confirms execution only; verify the requested external state separately.'
      else if (outcome.status === 'error')
        text = `Script failed${outcome.line === undefined ? '' : ` at line ${outcome.line}`}: ${outcome.message}`
      else if (outcome.status === 'stopped' && outcome.reason === 'timeout')
        text = `Script timed out after ${timeoutMs} ms. Delivered inputs are not undone.`
      content.push({ text, type: 'text' })
      return { content, isError: !succeeded }
    }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)) }
    finally {
      this.#active = undefined
    }
  }
}

/**
 * Adds codemode to the typed ACP connection. The SDK owns protocol messages.
 * This adapter owns session setup, briefing, and tool endpoint cleanup.
 */
export function codeModeConnection(connection: AcpClientConnection, host: CodeModeHost, tools: ServedMcp, briefing: () => string): AcpClientConnection {
  let briefedSessionId: string | undefined
  const close = () => {
    host.cancel()
    tools.close()
  }
  if (connection.signal.aborted)
    close()
  else connection.signal.addEventListener('abort', close, { once: true })
  return {
    ...connection,
    cancel(sessionId) {
      host.cancel()
      return connection.cancel(sessionId)
    },
    newSession(request) {
      host.setSession(undefined)
      return connection.newSession({ ...request, mcpServers: [...request.mcpServers, { headers: tools.headers, name: 'auv-playground', type: 'http', url: tools.url }] })
    },
    prompt(request) {
      // New sessions reuse the connection, so each receives its own briefing.
      if (briefedSessionId === request.sessionId)
        return connection.prompt(request)
      briefedSessionId = request.sessionId
      return connection.prompt({ ...request, prompt: [{ text: briefing(), type: 'text' }, ...request.prompt] })
    },
  }
}
