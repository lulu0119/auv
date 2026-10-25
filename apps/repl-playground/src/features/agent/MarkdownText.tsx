import type { CodeHeaderProps } from '@assistant-ui/react-markdown'

import remarkGfm from 'remark-gfm'

import { MarkdownTextPrimitive, memoizeMarkdownComponents } from '@assistant-ui/react-markdown'
import { useEffect, useState } from 'react'

import { copyText } from '../../clipboard'
import { IconButton } from '../../components/IconButton'

import '@assistant-ui/react-markdown/styles/dot.css'

function CodeHeader({ code, language }: CodeHeaderProps) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied)
      return
    const timer = setTimeout(setCopied, 3000, false)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="agent-code-header">
      <span>{language}</span>
      <IconButton
        hint={copied ? 'Copied' : 'Copy code'}
        icon={copied ? 'i-ph-check' : 'i-ph-copy'}
        onClick={() => void copyText(code).then(() => setCopied(true))}
      />
    </div>
  )
}

const components = memoizeMarkdownComponents({
  CodeHeader,
  table: props => <div className="agent-markdown-table"><table {...props} /></div>,
})

// assistant-ui's MarkdownText composition, using the existing theme and clipboard:
// https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/react/assistant-ui/elements/markdown-text.tsx
export function MarkdownText({ className }: { className: string }) {
  return <MarkdownTextPrimitive className={className} components={components} defer remarkPlugins={[remarkGfm]} />
}
