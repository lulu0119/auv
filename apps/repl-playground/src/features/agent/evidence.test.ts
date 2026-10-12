import { describe, expect, it } from 'vitest'

import { formatRunEvidence } from './evidence'

describe('formatRunEvidence', () => {
  it('formats an error run with calls and logs', () => {
    expect(formatRunEvidence({
      calls: [
        { effect: 'read', line: 1, method: 'windows.resolve', status: 'ok' },
        { effect: 'input', error: 'window is gone', line: 2, method: 'windows.click', status: 'error' },
      ],
      errorLine: 2,
      errorMessage: 'window is gone',
      logs: [{ level: 'error', line: 2, text: 'window is gone' }],
      mode: 'live',
      status: 'error',
    })).toBe([
      'Run error (live).',
      'Error at line 2: window is gone',
      'Calls (2):',
      '- L1 windows.resolve [read] ok',
      '- L2 windows.click [input] error: window is gone',
      'Console:',
      '- L2 error: window is gone',
    ].join('\n'))
  })

  it('formats a clean run without sections', () => {
    expect(formatRunEvidence({ calls: [], logs: [], mode: 'live', status: 'done' })).toBe('Run done (live).')
  })
})
