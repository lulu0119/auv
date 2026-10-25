import type { ToolCallContent } from '@agentclientprotocol/sdk'
import type { ReasoningMessagePartComponent, TextMessagePartComponent, ToolCallMessagePartComponent } from '@assistant-ui/react'

import Markdown from 'react-markdown'

import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useAcpPermissions, useAcpRuntimeExtras, useAcpSession } from '@hafbit/react-acp'
import { useState } from 'react'

import { iconButtonClassName } from '../../components/icon-button-class'
import { IconButton } from '../../components/IconButton'
import { isSandboxBriefing } from './agent-context'

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
    <ThreadPrimitive.Root className="flex flex-col h-full min-h-0">
      <ApprovalList />
      <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-3 flex flex-col gap-3">
          <ThreadPrimitive.Messages>{() => <AgentMessage />}</ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <AgentToolbar />
      <div className="p-2 border-t border-line shrink-0">
        <ComposerPrimitive.Root className="py-1 pl-2.5 pr-1 border border-line rounded-md bg-surface-1 flex gap-1.5 items-end focus-within:border-accent">
          <ComposerPrimitive.Input
            aria-label="Message the agent"
            className="text-[13px] text-fg py-1 outline-none bg-transparent flex-1 min-w-0 placeholder:text-fg-subtle"
            maxRows={6}
            placeholder="Ask the agent to operate the playground…"
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
      </div>
    </ThreadPrimitive.Root>
  )
}

const AgentText: TextMessagePartComponent = ({ text }) => {
  if (!text)
    return <span className="text-fg-subtle animate-pulse">●</span>
  return (
    <div className="agent-md text-[12.5px] text-fg leading-relaxed">
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

const AgentTool: ToolCallMessagePartComponent = ({ argsText, result, status, toolCallId, toolName }) => {
  const tool = useAcpSession()?.tools[toolCallId]?.value
  const content = tool?.content
  return (
    <details className="text-[12px] text-fg-muted border border-line rounded-md bg-surface-0 min-w-0">
      <summary className="px-2 py-1 cursor-pointer">
        <span className="font-mono">{tool?.title ?? toolName}</span>
        {/* A wrapper can complete and return a nested error. Keep its ACP
            status and the returned result separate instead of guessing status. */}
        <span className="ml-2">{status?.type ?? ''}</span>
      </summary>
      <div className="px-2 pb-2 flex flex-col gap-2">
        <div>
          <div className="text-fg-subtle">Input</div>
          <pre className="font-mono whitespace-pre-wrap break-words">{argsText}</pre>
        </div>
        {(!!content?.length || result !== undefined) && (
          <div>
            <div className="text-fg-subtle">Result</div>
            {content?.length
              ? content.map((part, index) => (
                  // eslint-disable-next-line react/no-array-index-key -- ACP supplies ordered blocks without IDs; this renderer has no local state.
                  <AgentToolContent content={part} key={index} />
                ))
              : <pre className="font-mono whitespace-pre-wrap break-words">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>}
          </div>
        )}
        {!!content?.length && tool?.rawOutput !== undefined && (
          <details>
            <summary className="text-fg-subtle cursor-pointer">Raw output</summary>
            <pre className="font-mono whitespace-pre-wrap break-words">{typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput, null, 2)}</pre>
          </details>
        )}
      </div>
    </details>
  )
}

/** Render ACP text and screenshots without turning image bytes into a JSON wall. */
function AgentToolContent({ content }: { content: ToolCallContent }) {
  if (content.type === 'content') {
    const block = content.content
    if (block.type === 'text')
      return <pre className="font-mono whitespace-pre-wrap break-words">{block.text}</pre>
    if (block.type === 'image')
      return <img alt="Tool result" className="mt-1 rounded h-auto max-w-full" loading="lazy" src={`data:${block.mimeType};base64,${block.data}`} />
  }
  return <pre className="font-mono whitespace-pre-wrap break-words">{JSON.stringify(content, null, 2)}</pre>
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
    <div className="flex justify-end">
      <div className="px-3 py-2 rounded-lg bg-surface-2 max-w-[90%] whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function AgentMessage() {
  const role = useAuiState(s => s.message.role)
  if (role === 'user')
    return <MessagePrimitive.Parts components={{ Text: UserText }} />
  return (
    <div className="min-w-0">
      <MessagePrimitive.Parts components={{ Reasoning: AgentReasoning, Text: AgentText, tools: { Fallback: AgentTool } }} />
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
    <div className="px-2 py-1.5 border-t border-line flex shrink-0 gap-1 items-center">
      <IconButton disabled={busy} hint="Start a new agent session" icon="i-ph-plus" label="New" onClick={newSession} />
      <span className="text-[11.5px] text-fg-muted">Code execution connected</span>
      {notice && <span className="text-[11.5px] text-fg-muted flex-1 truncate">{notice}</span>}
    </div>
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
