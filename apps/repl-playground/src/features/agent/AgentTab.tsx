import type { AgentConnection } from './AgentSession'
import type { AccountSession, AgentTarget } from './exterior'

import { useCallback, useEffect, useRef, useState } from 'react'

import { Empty } from '../../components/Empty'
import { Field, Hint } from '../../components/Field'
import { AgentSession } from './AgentSession'
import { listTargets, openAgentConnection, useAccount } from './exterior'

const maxAutoRetries = 2

/**
 * Agent tab: Exterior sign-in, one of the account's online devices, then a
 * fresh ACP session. The session is never persisted: a new ticket spawns a new
 * agent process, and disconnecting kills it.
 * TODO(agent-session-persist): a reload drops the chat while the script
 * survives (CodeEditor keeps it in localStorage). Restoring the chat needs the
 * Exterior daemon to keep the agent process and to load the ACP session;
 * that lives in the Exterior repo, so it stays out of this tab.
 */
export function AgentTab() {
  const session = useAccount()
  const signedIn = session.account.phase === 'signed-in'
  const openConnection = session.openConnection
  const [target, setTarget] = useState<AgentTarget | null>(null)
  const [ticket, setTicket] = useState<AgentConnection | null>(null)
  const [ticketError, setTicketError] = useState('')
  const [opening, setOpening] = useState(false)
  const [autoRetries, setAutoRetries] = useState(0)
  const retryingRef = useRef(false)

  const openTicket = useCallback(async (next: AgentTarget) => {
    if (!signedIn)
      return
    setOpening(true)
    setTicketError('')
    try {
      setTicket(await openAgentConnection(openConnection, next))
    }
    catch (cause) {
      setTicketError(cause instanceof Error ? cause.message : String(cause))
    }
    finally {
      setOpening(false)
      retryingRef.current = false
    }
  }, [openConnection, signedIn])

  // A ticket is single-use. React StrictMode mounts twice in dev, so the
  // ghost mount burns the first ticket and the live mount dies before ever
  // reaching ready. Reopen with a fresh ticket, bounded.
  const handleInfantDeath = useCallback(() => {
    if (!target || retryingRef.current || autoRetries >= maxAutoRetries)
      return
    retryingRef.current = true
    setAutoRetries(count => count + 1)
    console.warn(`Agent connection died before ready; reopening a fresh ticket (attempt ${autoRetries + 1}/${maxAutoRetries})`)
    void openTicket(target)
  }, [autoRetries, openTicket, target])

  const connect = useCallback((next: AgentTarget) => {
    setTarget(next)
    setTicket(null)
    setTicketError('')
    setAutoRetries(0)
    retryingRef.current = false
    void openTicket(next)
  }, [openTicket])

  const retry = useCallback(() => {
    if (!target)
      return
    setAutoRetries(0)
    void openTicket(target)
  }, [openTicket, target])

  const disconnect = useCallback(() => {
    setTarget(null)
    setTicket(null)
    setTicketError('')
    setAutoRetries(0)
    retryingRef.current = false
  }, [])

  if (!target) {
    // A sign-in phase change remounts the form for fresh device state.
    // Token refreshes keep the current selection.
    return <ConnectView key={session.account.phase} onConnected={connect} session={session} />
  }
  return (
    <AgentSession
      accessToken={session.accessToken}
      connection={ticket}
      onDisconnect={disconnect}
      onInfantDeath={handleInfantDeath}
      onRetry={retry}
      opening={opening}
      ticketError={ticketError}
    />
  )
}

function ConnectView({ onConnected, session }: {
  onConnected: (target: AgentTarget) => void
  session: AccountSession
}) {
  const [targets, setTargets] = useState<AgentTarget[]>([])
  const [selection, setSelection] = useState(0)
  const signedIn = session.account.phase === 'signed-in'
  const listDevices = session.listDevices
  // Remounted on every sign-in phase change (see the `key` in `AgentTab`), so
  // the initial status matches the current sign-in without syncing in the effect.
  const [status, setStatus] = useState(() => signedIn ? 'Checking the sign-in.' : '')

  useEffect(() => {
    if (!signedIn)
      return
    let cancelled = false
    void listTargets(listDevices)
      .then((listed) => {
        if (cancelled)
          return
        setTargets(listed)
        setStatus(listed.length === 0 ? 'No agent is available. Add an agent in Exterior on the device you want to use.' : '')
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setStatus(error instanceof Error ? error.message : 'Sign in again.')
      })
    return () => {
      cancelled = true
    }
  }, [listDevices, signedIn])

  if (session.account.phase === 'checking')
    return <Empty>Checking the sign-in.</Empty>

  if (session.account.phase === 'signed-out') {
    return (
      <div className="p-3 flex flex-col gap-2">
        <Hint>Connect an agent on one of your devices to work with this desktop.</Hint>
        <button className="btn-primary self-start" disabled={session.busy} onClick={session.signIn} type="button">
          <span className={session.busy ? 'i-ph-circle-notch animate-spin' : 'i-ph-sign-in'} />
          Sign in with Exterior
        </button>
        {session.error && <span className="text-[12px] text-bad">{session.error}</span>}
      </div>
    )
  }

  const connect = () => {
    const target = targets[selection]
    if (!target || !signedIn)
      return
    onConnected(target)
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      <Field label="Agent on your devices">
        <select
          aria-label="Agent on your devices"
          className="input"
          disabled={targets.length === 0}
          onChange={event => setSelection(Number(event.target.value))}
          value={selection}
        >
          {targets.map((target, index) => <option key={JSON.stringify([target.deviceId, target.agentName])} value={index}>{target.label}</option>)}
        </select>
      </Field>
      <div className="flex gap-2 items-center">
        <button className="btn-primary" disabled={!targets[selection]} onClick={connect} type="button">
          <span className="i-ph-plugs-connected" />
          Connect
        </button>
        <button className="btn-ghost" onClick={session.signOut} type="button">Sign out</button>
      </div>
      {status && <span className="text-[12px] text-fg-muted">{status}</span>}
      <Hint>Each connection starts a new agent session on the selected device. The chat closes when you disconnect.</Hint>
    </div>
  )
}
