import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useAcpConnection, useAcpRuntime, useAcpRuntimeExtras, useAcpThreadState } from '@hafbit/react-acp'
import { SdkAcpClientAdapter } from '@hafbit/react-acp/core'
import { useEffect, useRef, useState } from 'react'

import { version } from '../../../package.json'
import { Empty } from '../../components/Empty'
import { sandboxBriefing } from './agent-context'
import { AgentThread } from './AgentThread'
import { CodeModeHost, codeModeStream } from './codemode-bridge'

/** Provider-independent input for a fresh ACP connection. */
export interface AgentConnection {
  cwd: string
  label: string
  url: string
}

/**
 * One live ACP connection to the agent behind the ticket. Mounting connects;
 * unmounting closes the socket, and the host kills the agent process.
 * The thread below always starts a new session: it never loads or resumes a
 * session the host agent already has.
 */
export function AgentSession({ connection, onDisconnect, onInfantDeath, onRetry, opening, ticketError }: {
  connection: AgentConnection | null
  onDisconnect: () => void
  /** A connection that died before ever reaching ready; the parent reopens with a fresh ticket. */
  onInfantDeath: () => void
  /** Open a fresh ticket after a drop or an exhausted retry budget. */
  onRetry: () => void
  opening: boolean
  ticketError: string
}) {
  let body: React.ReactNode
  if (connection) {
    body = <LiveConnection connection={connection} key={connection.url} onInfantDeath={onInfantDeath} onRetry={onRetry} opening={opening} />
  }
  else if (ticketError) {
    body = (
      <Empty>
        <span className="flex flex-col gap-2 items-center">
          <span className="text-bad">{ticketError}</span>
          <button className="btn-ghost" onClick={onRetry} type="button">Retry</button>
        </span>
      </Empty>
    )
  }
  else {
    body = <Empty>{opening ? 'Opening the agent.' : 'Choose an agent to connect.'}</Empty>
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 border-b border-line flex shrink-0 gap-2 h-8 items-center">
        <span className="text-[12px] text-fg-muted font-medium flex-1 truncate">{connection?.label ?? 'Agent'}</span>
        <button className="btn-ghost text-[12px] px-2 h-6" onClick={onDisconnect} type="button">
          <span className="i-ph-plugs" />
          Disconnect
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {body}
      </div>
    </div>
  )
}

function AuthPanel() {
  // TODO(agent-auth): interactive ACP authentication requires an approved
  // agent-authentication flow; this panel reports the requirement.
  return <Empty>The agent requires authentication that this tab cannot complete.</Empty>
}

/** Human-readable form of the thread's connection error, when it carries one. */
function describeConnectionError(value: unknown): string {
  if (!value)
    return ''
  if (value instanceof Error)
    return value.message
  if (typeof value === 'string')
    return value
  try {
    const text = JSON.stringify(value)
    return text === '{}' ? '' : text
  }
  catch {
    return ''
  }
}

function LiveConnection({ connection, onInfantDeath, onRetry, opening }: {
  connection: AgentConnection
  onInfantDeath: () => void
  onRetry: () => void
  opening: boolean
}) {
  const [codemode] = useState(() => new CodeModeHost())
  const [supportsCodemode, setSupportsCodemode] = useState(false)
  const [adapter] = useState(() => new SdkAcpClientAdapter(({ signal }) => codeModeStream(
    createWebSocketStream(connection.url),
    codemode,
    signal,
    setSupportsCodemode,
    sandboxBriefing,
  )))
  const runtime = useAcpRuntime({
    clientCapabilities: { _meta: { auv: { codemode: 1 } } },
    clientInfo: { name: 'auv-playground', version },
    connection: { adapter, type: 'adapter' },
    // TODO(agent-directory): an explicit directory picker is deferred until
    // an approved workspace-selection slice; use the device's directory.
    workspace: { cwd: connection.cwd },
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionBody codemode={codemode} onInfantDeath={onInfantDeath} onRetry={onRetry} opening={opening} supportsCodemode={supportsCodemode} />
    </AssistantRuntimeProvider>
  )
}

function SessionBody({ codemode, onInfantDeath, onRetry, opening, supportsCodemode }: {
  codemode: CodeModeHost
  onInfantDeath: () => void
  onRetry: () => void
  opening: boolean
  supportsCodemode: boolean
}) {
  const { error, status } = useAcpConnection()
  const thread = useAcpThreadState()
  const extras = useAcpRuntimeExtras()
  const [failure, setFailure] = useState('')
  const creatingRef = useRef(false)
  const everReadyRef = useRef(false)
  const reportedRef = useRef(false)

  useEffect(() => {
    codemode.setSession(thread.activeSessionId)
    return () => codemode.cancel()
  }, [codemode, thread.activeSessionId])

  useEffect(() => {
    if (status === 'ready') {
      everReadyRef.current = true
      return
    }
    // A ticket is single-use, so a connection that dies before ever reaching
    // ready is not worth the runtime's own reconnect: the parent reopens
    // with a fresh ticket. Reported once per mount; a new ticket remounts.
    if ((status === 'closed' || status === 'error') && !everReadyRef.current && !reportedRef.current) {
      reportedRef.current = true
      onInfantDeath()
    }
  }, [status, onInfantDeath])

  // Each connection starts a fresh process and a new ACP session.
  useEffect(() => {
    const ensureSession = async () => {
      if (status !== 'ready' || !supportsCodemode || thread.activeSessionId !== undefined || creatingRef.current)
        return
      creatingRef.current = true
      setFailure('')
      try {
        await extras.createSession()
        await extras.refreshSessions()
      }
      catch (cause: unknown) {
        setFailure(cause instanceof Error ? cause.message : String(cause))
      }
      finally {
        creatingRef.current = false
      }
    }
    void ensureSession()
  }, [status, supportsCodemode, thread.activeSessionId, extras])

  if (status === 'auth-required')
    return <AuthPanel />
  if (status === 'error' || status === 'closed') {
    if (!everReadyRef.current && (opening || !reportedRef.current))
      return <Empty>{opening ? 'Reconnecting with a fresh ticket.' : 'Opening the agent.'}</Empty>
    const message = describeConnectionError(error) || status
    const hint = describeConnectionError(thread.connectionError)
    const phase = everReadyRef.current ? 'The session was running, then the connection dropped.' : 'The connection died before the first session was ready.'
    return (
      <Empty>
        <span className="flex flex-col gap-2 max-w-72 items-center">
          <span className="text-bad">{message}</span>
          <span className="text-[11.5px] text-fg-muted">{phase}</span>
          {hint && <span className="text-[11.5px] text-fg-muted">{hint}</span>}
          <span className="text-[11.5px] text-fg-muted">If this repeats, look at the daemon terminal on that machine: the agent process must start within 15 seconds, and a first-time download counts against that.</span>
          <button className="btn-ghost" onClick={onRetry} type="button">Reconnect</button>
        </span>
      </Empty>
    )
  }
  if (status !== 'ready')
    return <Empty>{status === 'connecting' ? 'Opening the agent.' : status}</Empty>
  if (!supportsCodemode) {
    return <Empty>This connection does not provide code execution. Configure the Playground agent proxy on the agent device, then reconnect.</Empty>
  }
  if (failure)
    return <Empty><span className="text-bad">{failure}</span></Empty>
  if (thread.activeSessionId === undefined)
    return <Empty>Starting a new session.</Empty>
  return <AgentThread />
}
