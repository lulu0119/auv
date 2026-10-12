import type { Machine } from '@mukae/contract'

import type { AccountSession } from './account'

import { listMachines, openConnection } from '@mukae/client'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Empty } from '../../components/Empty'
import { Field, Hint } from '../../components/Field'
import { useAccount } from './account'
import { AgentSession } from './AgentSession'
import { mukaeRelayUrl } from './relay'

/** One live agent behind a one-time ticket; the host kills its process on disconnect. */
export interface AgentConnection {
  agentType: string
  label: string
  url: string
}

/** The account's machine and agent slot a ticket is opened for. */
export interface AgentTarget {
  agentName: string
  label: string
  machineId: string
}

const maxAutoRetries = 2

/**
 * Agent column: Mukae sign-in, one of the account's online machines, then a
 * fresh ACP session. The session is never persisted: a new ticket spawns a new
 * agent process, and disconnecting kills it.
 * TODO(agent-session-persist): a reload drops the chat while the script
 * survives (CodeEditor keeps it in localStorage). Restoring the chat needs the
 * mukae daemon to keep the agent process and to load the ACP session; that
 * lives in the mukae repo, so it stays out of this column.
 */
export function AgentTab() {
  const relayUrl = mukaeRelayUrl()
  const session = useAccount(relayUrl)
  const accessToken = accessTokenOf(session)
  const [target, setTarget] = useState<AgentTarget | null>(null)
  const [ticket, setTicket] = useState<AgentConnection | null>(null)
  const [ticketError, setTicketError] = useState('')
  const [opening, setOpening] = useState(false)
  const [autoRetries, setAutoRetries] = useState(0)
  const retryingRef = useRef(false)

  const openTicket = useCallback(async (next: AgentTarget) => {
    if (!accessToken)
      return
    setOpening(true)
    setTicketError('')
    try {
      const opened = await openConnection(relayUrl, accessToken, { agentName: next.agentName, machineId: next.machineId })
      setTicket({ agentType: opened.agentType, label: next.label, url: opened.url })
    }
    catch (cause) {
      setTicketError(cause instanceof Error ? cause.message : String(cause))
    }
    finally {
      setOpening(false)
      retryingRef.current = false
    }
  }, [accessToken, relayUrl])

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
    // A new token means a different sign-in: remount for fresh machine state.
    return <ConnectView key={accessToken ?? 'signed-out'} onConnected={connect} relayUrl={relayUrl} session={session} />
  }
  return (
    <AgentSession
      connection={ticket}
      onDisconnect={disconnect}
      onInfantDeath={handleInfantDeath}
      onRetry={retry}
      opening={opening}
      ticketError={ticketError}
    />
  )
}

function accessTokenOf(session: AccountSession): string | undefined {
  return session.account.phase === 'signed-in' ? session.account.accessToken : undefined
}

function ConnectView({ onConnected, relayUrl, session }: {
  onConnected: (target: AgentTarget) => void
  relayUrl: string
  session: AccountSession
}) {
  const [machines, setMachines] = useState<Machine[]>([])
  const [selection, setSelection] = useState('')
  const accessToken = accessTokenOf(session)
  // Remounted on every access-token change (see the `key` in `AgentTab`), so
  // the initial status matches the current sign-in without syncing in the effect.
  const [status, setStatus] = useState(() => accessToken ? 'Checking the sign-in.' : '')

  useEffect(() => {
    if (!accessToken)
      return
    let cancelled = false
    void listMachines(relayUrl, accessToken)
      .then((listed) => {
        if (cancelled)
          return
        setMachines(listed)
        const first = listed.find(machine => machine.agents.length > 0)
        const agent = first?.agents[0]
        if (first && agent)
          setSelection(selectionOf(first.id, agent.name))
        setStatus(listed.length === 0 ? 'No machine is online. On that computer, run mukae daemon.' : '')
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setStatus(error instanceof Error ? error.message : 'Sign in again.')
      })
    return () => {
      cancelled = true
    }
  }, [relayUrl, accessToken])

  const items = machines.flatMap(machine => machine.agents.map(agent => ({
    label: `${machine.hostname} / ${agent.name}`,
    value: selectionOf(machine.id, agent.name),
  })))

  if (session.account.phase === 'checking')
    return <Empty>Checking the sign-in.</Empty>

  if (session.account.phase === 'signed-out') {
    return (
      <div className="p-3 flex flex-col gap-2">
        <Hint>Sign in with Mukae, then open an agent on one of your machines. The agent writes scripts; the sandbox runs them on the mock desktop.</Hint>
        <button className="btn-primary self-start" disabled={session.busy} onClick={session.signIn} type="button">
          <span className={session.busy ? 'i-ph-circle-notch animate-spin' : 'i-ph-sign-in'} />
          Sign in with Mukae
        </button>
        {session.error && <span className="text-[12px] text-bad">{session.error}</span>}
      </div>
    )
  }

  const connect = () => {
    const parsed = parseSelection(selection)
    if (!parsed || !accessToken)
      return
    onConnected({
      agentName: parsed.agentName,
      label: items.find(item => item.value === selection)?.label ?? parsed.agentName,
      machineId: parsed.machineId,
    })
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      <Field label="Agent on your machines">
        <select
          aria-label="Agent on your machines"
          className="input"
          disabled={items.length === 0}
          onChange={event => setSelection(event.target.value)}
          value={selection}
        >
          {items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </Field>
      <div className="flex gap-2 items-center">
        <button className="btn-primary" disabled={!selection} onClick={connect} type="button">
          <span className="i-ph-plugs-connected" />
          Connect
        </button>
        <button className="btn-ghost" onClick={session.signOut} type="button">Sign out</button>
      </div>
      {status && <span className="text-[12px] text-fg-muted">{status}</span>}
      <Hint>One connection spawns a fresh agent process on that machine. Disconnecting kills it; nothing is kept.</Hint>
    </div>
  )
}

function parseSelection(value: string): undefined | { agentName: string, machineId: string } {
  const separator = value.indexOf('\t')
  if (separator < 1)
    return undefined
  return { agentName: value.slice(separator + 1), machineId: value.slice(0, separator) }
}

function selectionOf(machineId: string, agentName: string): string {
  return `${machineId}\t${agentName}`
}
