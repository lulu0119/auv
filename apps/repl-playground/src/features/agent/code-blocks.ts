/** One fenced code block in an agent message. */
export interface CodeBlock {
  code: string
  language: string
}

/** Splits assistant markdown into text and fenced code blocks, in order. */
export type MessageSegment = { code: string, language: string, type: 'code' } | { text: string, type: 'text' }

const fencePattern = /^```([\w+-]*)\n([\s\S]*?)^```/m

/** Extracts every fenced code block; unmatched text is dropped. */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  return segmentsOf(markdown).flatMap(segment => segment.type === 'code' ? [{ code: segment.code, language: segment.language }] : [])
}

/** Whether the block reads as a playground script the editor can run. */
export function isRunnableBlock(block: CodeBlock): boolean {
  return block.language === '' || block.language === 'ts' || block.language === 'typescript' || block.language === 'js' || block.language === 'javascript'
}

export function segmentsOf(markdown: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let rest = markdown
  let match = fencePattern.exec(rest)
  while (match) {
    const before = rest.slice(0, match.index).trim()
    if (before)
      segments.push({ text: before, type: 'text' })
    segments.push({ code: match[2].replace(/\n$/, ''), language: match[1].toLowerCase(), type: 'code' })
    rest = rest.slice(match.index + match[0].length)
    match = fencePattern.exec(rest)
  }
  if (rest.trim())
    segments.push({ text: rest.trim(), type: 'text' })
  return segments
}
