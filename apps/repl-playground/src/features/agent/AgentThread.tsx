import type { ReasoningMessagePartComponent, TextMessagePartComponent, ToolCallMessagePartComponent } from '@assistant-ui/react'
import type { useAcpRuntime } from '@hafbit/react-acp'

import Markdown from 'react-markdown'

import { AuiIf, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useAcpPermissions, useAcpRuntimeExtras } from '@hafbit/react-acp'
import { useState } from 'react'

import { CopyButton } from '../../components/CopyButton'
import { iconButtonClassName } from '../../components/icon-button-class'
import { IconButton } from '../../components/IconButton'
import { usePlayground } from '../../store'
import { isSandboxBriefing } from './agent-context'
import { appendUserMessage } from './append'
import { isRunnableBlock, segmentsOf } from './code-blocks'
import { applyScriptToEditor } from './editor-bridge'
import { formatRunEvidence, valueToText } from './evidence'

/**
 * Chat over the live ACP connection: assistant messages with appliable
 * script blocks, tool-call rows, permission approvals, a composer, and the
 * agent toolbar (new session, send run evidence back). Run and reset live in
 * the editor and the activity bar. Styling is the
 * playground's own; the session protocol comes from
 * `@hafbit/react-acp` and `@assistant-ui/react`, not hand-rolled.
 */
export function AgentThread({ runtime }: {
  runtime: ReturnType<typeof useAcpRuntime>
}) {
  return (
    <ThreadPrimitive.Root className="flex flex-col h-full min-h-0">
      <ApprovalList />
      <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-3 flex flex-col gap-3">
          <ThreadPrimitive.Messages>{() => <AgentMessage />}</ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <AgentToolbar runtime={runtime} />
      <div className="p-2 border-t border-line shrink-0">
        <ComposerPrimitive.Root className="py-1 pl-2.5 pr-1 border border-line rounded-md bg-surface-1 flex gap-1.5 items-end focus-within:border-accent">
          <ComposerPrimitive.Input
            aria-label="Message the agent"
            className="text-[13px] text-fg py-1 outline-none bg-transparent flex-1 min-w-0 placeholder:text-fg-subtle"
            maxRows={6}
            placeholder="Ask the agent for a script…"
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
  const segments = segmentsOf(text)
  if (segments.length === 0)
    return <span className="text-fg-subtle animate-pulse">●</span>
  return (
    <div className="flex flex-col gap-2">
      {segments.map((segment, index) => segment.type === 'text'
        ? (
            <div className="agent-md text-[12.5px] text-fg leading-relaxed" key={index}>
              <Markdown>{segment.text}</Markdown>
            </div>
          )
        : (
            <AgentCodeBlock code={segment.code} key={index} language={segment.language} />
          ))}
    </div>
  )
}

function AgentCodeBlock({ code, language }: { code: string, language: string }) {
  const runnable = isRunnableBlock({ code, language })
  return (
    <div className="border border-line rounded-md overflow-hidden">
      <div className="px-2 border-b border-line bg-surface-0 flex h-7 items-center">
        <span className="text-[11px] text-fg-subtle font-mono flex-1">{language || 'text'}</span>
        <CopyButton label="Copy code" text={code} />
        {runnable && (
          <button className="btn-ghost text-[11.5px] px-2 h-6" onClick={() => applyScriptToEditor(code)} type="button">
            <span className="i-ph-arrow-square-in" />
            Apply to editor
          </button>
        )}
      </div>
      <pre className="text-[11.5px] font-mono p-2 max-h-64 whitespace-pre-wrap overflow-auto">{code}</pre>
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

const AgentTool: ToolCallMessagePartComponent = ({ argsText, status, toolName }) => (
  <div className="text-[12px] text-fg-muted px-2 py-1 border border-line rounded-md bg-surface-0 flex gap-2 items-center">
    <span className="i-ph-wrench shrink-0" />
    <span className="font-mono flex-1 truncate">{toolName}</span>
    <span className="shrink-0">{status?.type ?? ''}</span>
    {argsText && <span className="text-fg-subtle font-mono max-w-48 truncate">{argsText}</span>}
  </div>
)

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

/** Agent actions: start a new session and send finished-run evidence back. */
function AgentToolbar({ runtime }: {
  runtime: ReturnType<typeof useAcpRuntime>
}) {
  const runStatus = usePlayground(state => state.run.status)
  const runIndex = usePlayground(state => state.runIndex)
  const extras = useAcpRuntimeExtras()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [sentRun, setSentRun] = useState<null | number>(null)
  const finished = runStatus === 'done' || runStatus === 'error' || runStatus === 'stopped'

  const sendEvidence = () => {
    const state = usePlayground.getState()
    if (state.run.status !== 'done' && state.run.status !== 'error' && state.run.status !== 'stopped') {
      setNotice('Wait for the run to finish first.')
      return
    }
    const evidence = formatRunEvidence({
      calls: state.calls.map(call => ({ effect: call.effect, error: call.error, line: call.line, method: call.method, status: call.status })),
      errorLine: state.run.errorLine,
      errorMessage: state.run.errorMessage,
      logs: state.logs.map(entry => ({ level: entry.level, line: entry.line, text: entry.values.map(valueToText).join(' ') })),
      mode: state.run.mode,
      status: state.run.status,
    })
    try {
      appendUserMessage(runtime, evidence)
      setSentRun(state.runIndex)
      setNotice('')
    }
    catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const newSession = () => {
    if (busy)
      return
    setBusy(true)
    setNotice('')
    // TODO(agent-session-list): the old session lingers in the host agent
    // process; delete it when the agent advertises the capability.
    void extras.createSession()
      .then(() => extras.refreshSessions())
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="px-2 py-1.5 border-t border-line flex shrink-0 gap-1 items-center">
      <IconButton hint="Start a new agent session" icon="i-ph-plus" label="New" onClick={newSession} />
      <IconButton
        disabled={!finished || sentRun === runIndex}
        hint="Send the finished run back to the agent"
        icon="i-ph-exam"
        label="Evidence"
        onClick={sendEvidence}
      />
      {notice && <span className="text-[11.5px] text-fg-muted flex-1 truncate">{notice}</span>}
    </div>
  )
}

/**
 * Tool permission requests, forwarded unchanged by the relay. Nothing is
 * approved automatically: the agent only reaches the sandbox through applied
 * scripts, never through its own local tools, unless the human allows it here.
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
            title="Needs your confirmation. Local tools cannot see the mock desktop."
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
