import type { ToolCallContent } from '@agentclientprotocol/sdk'
import type { ToolCallMessagePartComponent } from '@assistant-ui/react'
import type { PropsWithChildren } from 'react'

import { useAuiState } from '@assistant-ui/react'
import { Dialog } from '@base-ui/react/dialog'
import { useAcpSession } from '@hafbit/react-acp'

import { formatValue, presentTool } from './tool-presentation'

/** Adjacent tool activity stays folded; returned errors and images remain visible. */
export function AgentActivity({ children, indices }: PropsWithChildren<{ indices: readonly number[] }>) {
  const parts = useAuiState(s => s.message.content)
  const session = useAcpSession()
  const tools = indices.flatMap((index) => {
    const part = parts[index]
    const tool = part?.type === 'tool-call' ? session?.tools[part.toolCallId] : undefined
    return tool ? [{ ...presentTool(tool.value), id: tool.toolCallId, value: tool.value }] : []
  })
  const errors = tools.filter(tool => tool.error)
  const running = tools.some(tool => tool.running)
  const names = [...new Set(tools.map(tool => tool.title))].join(', ')
  const images = tools.flatMap(tool => (tool.value.content ?? []).flatMap((part, index) => part.type === 'content' && part.content.type === 'image'
    ? [{ id: `${tool.id}:${index}`, image: `data:${part.content.mimeType};base64,${part.content.data}` }]
    : []))
  return (
    <div className="agent-activity" data-agent-activity="">
      <details className="agent-activity-list">
        <summary className="agent-activity-heading">
          <span aria-hidden="true" className={running ? 'i-ph-circle-notch animate-spin' : 'i-ph-stack-simple'} />
          <span>{running ? 'Working' : `${tools.length} ${tools.length === 1 ? 'activity' : 'activities'}`}</span>
          <span className="agent-activity-names" title={names}>{names}</span>
          {!!errors.length && <span className="agent-issue-count">{`${errors.length} ${errors.length === 1 ? 'issue' : 'issues'}`}</span>}
          <span aria-hidden="true" className="i-ph-caret-right agent-activity-chevron" />
        </summary>
        <div className="agent-activity-steps">{children}</div>
      </details>
      {!!errors.length && (
        <div className="agent-activity-errors">
          {errors.map(tool => <p key={tool.id} title={tool.errorText}>{tool.errorText}</p>)}
        </div>
      )}
      {!!images.length && (
        <div aria-label="Screenshots" className="agent-screenshots">
          {images.map((item, index) => <AgentScreenshot image={item.image} key={item.id} label={`Screenshot ${index + 1}`} />)}
        </div>
      )}
    </div>
  )
}

/** The execution outcome is separate from the wrapper's original protocol status. */
export const AgentTool: ToolCallMessagePartComponent = ({ argsText, result, status, toolCallId, toolName }) => {
  const tool = useAcpSession()?.tools[toolCallId]?.value
  const presentation = tool ? presentTool(tool) : { error: false, running: status.type === 'running', script: undefined, status: status.type, title: toolName }
  const content = tool?.content?.filter(part => part.type !== 'content' || part.content.type !== 'image')
  return (
    <details className="agent-tool" data-tool-id={toolCallId} data-tool-status={presentation.status}>
      <summary>
        <span aria-hidden="true" className={presentation.running ? 'i-ph-circle-notch animate-spin' : presentation.error ? 'i-ph-warning-circle' : 'i-ph-check'} />
        <span className="agent-tool-title">{presentation.title}</span>
        <span className="agent-tool-status">{presentation.running ? 'Running' : presentation.error ? 'Returned an error' : 'Finished'}</span>
        <span aria-hidden="true" className="i-ph-caret-right agent-activity-chevron" />
      </summary>
      <div className="agent-tool-body">
        {(!!content?.length || (!tool?.content?.length && result !== undefined)) && (
          <div className="agent-tool-result">
            <div className="agent-detail-label">Result</div>
            {content?.length
              ? content.map((part, index) => (
                  // eslint-disable-next-line react/no-array-index-key -- ACP supplies ordered blocks without IDs; this renderer has no local state.
                  <AgentToolContent content={part} key={index} />
                ))
              : <pre>{formatValue(result)}</pre>}
          </div>
        )}
        {presentation.script && (
          <details className="agent-tool-detail">
            <summary>Script</summary>
            <pre data-tool-script="">{presentation.script}</pre>
          </details>
        )}
        <details className="agent-tool-detail">
          <summary>Protocol details</summary>
          <div className="agent-detail-label">{`ACP status: ${tool?.status ?? status.type}`}</div>
          <div className="agent-detail-label">Raw input</div>
          <pre>{tool?.rawInput === undefined ? argsText : formatValue(tool.rawInput)}</pre>
          <div className="agent-detail-label">Raw output</div>
          <pre>{formatValue(tool?.rawOutput ?? result)}</pre>
        </details>
      </div>
    </details>
  )
}

/** Preview the bounded image already returned by the agent; opening fetches no extra pixels. */
function AgentScreenshot({ image, label }: { image: string, label: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger aria-label={`View ${label.toLowerCase()}`} className="agent-screenshot" type="button">
        <img alt={label} loading="lazy" src={image} />
        <span>
          {label}
          <span aria-hidden="true" className="i-ph-arrows-out" />
        </span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="agent-image-backdrop" />
        <Dialog.Popup className="agent-image-dialog">
          <div className="agent-image-toolbar">
            <Dialog.Title>{label}</Dialog.Title>
            <Dialog.Close aria-label="Close screenshot" className="btn-ghost" type="button"><span className="i-ph-x" /></Dialog.Close>
          </div>
          <img alt={`${label} preview`} src={image} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Preserve other ACP content as readable data instead of dropping it. */
function AgentToolContent({ content }: { content: ToolCallContent }) {
  return <pre>{content.type === 'content' && content.content.type === 'text' ? content.content.text : formatValue(content)}</pre>
}
