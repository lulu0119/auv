import { describe, expect, it } from 'vitest'

import { extractCodeBlocks, isRunnableBlock, segmentsOf } from './code-blocks'

describe('segmentsOf', () => {
  it('splits text and fenced blocks in order', () => {
    const segments = segmentsOf('Try this:\n```ts\nconst a = 1\n```\nDone.')
    expect(segments).toEqual([
      { text: 'Try this:', type: 'text' },
      { code: 'const a = 1', language: 'ts', type: 'code' },
      { text: 'Done.', type: 'text' },
    ])
  })

  it('keeps several blocks and drops empty text', () => {
    expect(extractCodeBlocks('```ts\na\n```\n```bash\nb\n```')).toEqual([
      { code: 'a', language: 'ts' },
      { code: 'b', language: 'bash' },
    ])
  })

  it('returns plain text as one segment', () => {
    expect(segmentsOf('no fences here')).toEqual([{ text: 'no fences here', type: 'text' }])
  })
})

describe('isRunnableBlock', () => {
  it('accepts script languages', () => {
    expect(isRunnableBlock({ code: '', language: 'ts' })).toBe(true)
    expect(isRunnableBlock({ code: '', language: '' })).toBe(true)
    expect(isRunnableBlock({ code: '', language: 'bash' })).toBe(false)
  })
})
