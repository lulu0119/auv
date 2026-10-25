import type { ReasoningMessagePartComponent, TextMessagePartComponent } from '@assistant-ui/react'

import Markdown from 'react-markdown'

import { AuiIf, ComposerPrimitive, groupPartByType, MessagePrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useAcpPermissions, useAcpRuntimeExtras } from '@hafbit/react-acp'
import { useState } from 'react'

import { iconButtonClassName } from '../../components/icon-button-class'
import { IconButton } from '../../components/IconButton'
import { isSandboxBriefing } from './agent-context'
import { AgentActivity, AgentTool } from './AgentActivity'

import './agent.css'

/**
 * Chat over the live ACP connection: assistant messages, tool-call rows,
 * permission approvals, a composer, and new sessions. Codemode returns run
 * results directly to the agent. Run and reset also live in the editor and
 * the activity bar. Styling is the
 * playground's own; the session protocol comes from
 * `@hafbit/react-acp` and `@assistant-ui/react`, not hand-rolled.
 */
export function AgentThread() {
  return (
    <ThreadPrimitive.Root className="agent-thread">
      <ApprovalList />
      <div className="agent-conversation">
        <ThreadPrimitive.Viewport className="agent-viewport">
          <ThreadPrimitive.Empty>
            <div className="agent-empty">
              <span aria-hidden="true" className="i-ph-cursor-click" />
              <strong>Work with your desktop</strong>
              <p>Describe a task. Follow the agent's progress and inspect its results here.</p>
            </div>
          </ThreadPrimitive.Empty>
          <div className="agent-messages">
            <ThreadPrimitive.Messages>{() => <AgentMessage />}</ThreadPrimitive.Messages>
          </div>
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom aria-label="Jump to latest message" className="agent-jump-latest" type="button">
          <span className="i-ph-arrow-down" />
          Latest
        </ThreadPrimitive.ScrollToBottom>
      </div>
      <div className="agent-composer">
        <ComposerPrimitive.Root className="agent-composer-input">
          <ComposerPrimitive.Input
            aria-label="Message the agent"
            maxRows={4}
            placeholder="What would you like to do on this desktop?"
          />
          <AuiIf condition={s => !s.composer.canCancel}>
            <ComposerPrimitive.Send aria-label="Send" className={iconButtonClassName({ tone: 'primary' })}>
              <span className="i-ph-paper-plane-tilt-fill text-[15px]" />
            </ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={s => s.composer.canCancel}>
            <ComposerPrimitive.Cancel aria-label="Stop" className={iconButtonClassName({})}>
              <span className="i-ph-stop-fill text-[15px]" />
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </ComposerPrimitive.Root>
        <div className="agent-composer-meta">
          <span className="agent-connection-state">
            <span />
            Connected
          </span>
          <span className="agent-composer-hint">Enter to send</span>
          <AgentToolbar />
        </div>
      </div>
    </ThreadPrimitive.Root>
  )
}

const AgentText: TextMessagePartComponent = ({ text }) => {
  if (!text)
    return <span className="text-fg-subtle animate-pulse">●</span>
  return (
    <div className="agent-md agent-text">
      <Markdown>{text}</Markdown>
    </div>
  )
}

const AgentReasoning: ReasoningMessagePartComponent = ({ text }) => {
  if (!text)
    return null
  return (
    <details className="text-[12px] text-fg-muted">
      <summary className="cursor-pointer">Reasoning</summary>
      <div className="agent-md leading-relaxed mt-1">
        <Markdown>{text}</Markdown>
      </div>
    </details>
  )
}

const UserText: TextMessagePartComponent = ({ text }) => {
  if (isSandboxBriefing(text)) {
    return (
      <details className="text-[11.5px] text-fg-subtle">
        <summary className="cursor-pointer">Sandbox briefing</summary>
        <pre className="text-[11px] font-mono mt-1 whitespace-pre-wrap">{text}</pre>
      </details>
    )
  }
  return (
    <div className="agent-user-message">
      <div>{text}</div>
    </div>
  )
}

function AgentMessage() {
  const role = useAuiState(s => s.message.role)
  if (role === 'user')
    return <MessagePrimitive.Parts components={{ Text: UserText }} />
  return (
    <div className="agent-assistant-message">
      <MessagePrimitive.GroupedParts groupBy={groupPartByType({ 'tool-call': ['group-activity'] })} indicator="empty">
        {({ children, part }) => {
          switch (part.type) {
            case 'data': return part.dataRendererUI
            case 'group-activity': return <AgentActivity indices={part.indices}>{children}</AgentActivity>
            case 'image': return <img alt="Agent image" className="max-w-full" src={part.image} />
            case 'indicator': return (
              <div aria-live="polite" className="agent-thinking">
                <span className="i-ph-circle-notch animate-spin" />
                Thinking…
              </div>
            )
            case 'reasoning': return <AgentReasoning {...part} />
            case 'text': return <AgentText {...part} />
            case 'tool-call': return part.toolUI ?? <AgentTool {...part} />
            default: return null
          }
        }}
      </MessagePrimitive.GroupedParts>
    </div>
  )
}

/** Start a new session on the existing connection. */
function AgentToolbar() {
  const extras = useAcpRuntimeExtras()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const newSession = () => {
    if (busy)
      return
    setBusy(true)
    setNotice('')
    // TODO(agent-session-list): session disposal requires a host close
    // capability; add it with an approved session-lifecycle contract.
    void extras.createSession()
      .then(() => extras.refreshSessions())
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      {notice && <span className="text-[11.5px] text-bad flex-1 truncate" role="alert">{notice}</span>}
      <IconButton disabled={busy} hint="Start a new agent session" icon="i-ph-plus" label="New session" onClick={newSession} />
    </>
  )
}

/**
 * Tool permission requests, forwarded unchanged by the relay. Nothing is
 * approved automatically. Codemode reaches the selected Playground device;
 * the agent's other tools may request separate permission here.
 */
function ApprovalList() {
  const { pending, reply } = useAcpPermissions()
  if (pending.length === 0)
    return null
  return (
    <div className="p-1.5 border-b border-line flex shrink-0 flex-col gap-1">
      {pending.map(({ request }) => {
        const { toolCallId } = request.toolCall
        const allowOnce = request.options.find(option => option.kind === 'allow_once')
        const allowAlways = request.options.find(option => option.kind === 'allow_always')
        const reject = request.options.find(option => option.kind === 'reject_once')
          ?? request.options.find(option => option.kind === 'reject_always')
        return (
          <div
            className="px-2 py-1 border border-warn/40 rounded-md bg-surface-0 flex gap-1.5 items-center"
            key={toolCallId}
            title="Needs your confirmation. The agent's local tools run on its own machine."
          >
            <span className="text-[12px] text-fg font-mono flex-1 truncate">{request.toolCall.title ?? 'Tool call'}</span>
            {allowOnce && <button className="btn-primary text-[11.5px] px-2 h-6" onClick={() => void reply(toolCallId, allowOnce.optionId)} type="button">Allow</button>}
            {allowAlways && <button className="btn-ghost text-[11.5px] px-2 border border-line h-6" onClick={() => void reply(toolCallId, allowAlways.optionId)} type="button">Always</button>}
            <button className="btn-ghost text-[11.5px] px-2 h-6" onClick={() => void reply(toolCallId, reject?.optionId)} type="button">Deny</button>
          </div>
        )
      })}
    </div>
  )
}
