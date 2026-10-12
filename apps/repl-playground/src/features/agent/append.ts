import type { useAcpRuntime } from '@hafbit/react-acp'

/**
 * Appends a user message that continues the thread. Uses the short append
 * form on purpose: an explicit `parentId: null` reads as "edit history" once
 * the thread has messages, and this runtime rejects edits.
 */
export function appendUserMessage(runtime: ReturnType<typeof useAcpRuntime>, text: string): void {
  runtime.thread.append({ content: [{ text, type: 'text' }], role: 'user' })
}
