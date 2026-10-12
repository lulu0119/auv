/** Serializable snapshot of one finished script run, for agent evidence. */
export interface RunEvidence {
  calls: Array<{
    effect: 'input' | 'read'
    error?: string
    line: null | number
    method: string
    status: 'error' | 'ok' | 'pending'
  }>
  errorLine?: number
  errorMessage?: string
  logs: Array<{
    level: string
    line: null | number
    text: string
  }>
  mode: 'live' | 'replay'
  status: string
}

const maxLogs = 20
const maxCalls = 40
const maxText = 2000

/** Formats one finished script run as text evidence for the agent's next turn. */
export function formatRunEvidence(evidence: RunEvidence): string {
  const lines = [`Run ${evidence.status} (${evidence.mode}).`]
  if (evidence.errorLine !== undefined || evidence.errorMessage !== undefined)
    lines.push(`Error${evidence.errorLine === undefined ? '' : ` at line ${evidence.errorLine}`}: ${evidence.errorMessage ?? 'unknown'}`)
  if (evidence.calls.length > 0) {
    lines.push(`Calls (${evidence.calls.length}):`)
    for (const call of evidence.calls.slice(-maxCalls))
      lines.push(`- L${call.line ?? '?'} ${call.method} [${call.effect}] ${call.status}${call.error ? `: ${clip(call.error)}` : ''}`)
  }
  if (evidence.logs.length > 0) {
    lines.push('Console:')
    for (const log of evidence.logs.slice(-maxLogs))
      lines.push(`- L${log.line ?? '?'} ${log.level}: ${clip(log.text)}`)
  }
  return lines.join('\n')
}

/** Renders one logged value as plain text for agent evidence. */
export function valueToText(value: unknown): string {
  if (typeof value === 'string')
    return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  }
  catch {
    return String(value)
  }
}

function clip(text: string): string {
  return text.length > maxText ? `${text.slice(0, maxText)}…` : text
}
