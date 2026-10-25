import catalog from 'virtual:auv-codemode-help'

import { createApiHelp } from '../../script-api/codemode-help'

const briefingOpening = 'You operate the selected AUV Playground environment on this page.'

/** Whether a user message is the sandbox briefing, so the thread can fold it instead of showing it as a human message. */
export function isSandboxBriefing(text: string): boolean {
  return text.startsWith(briefingOpening)
}

/** Briefing attached to the first prompt on a codemode connection. */
export function sandboxBriefing(): string {
  return [
    briefingOpening,
    'Your codemode MCP tool executes TypeScript in this page against its selected Device or mock desktop. Your local files and shell do not reach that environment.',
    'Use `auv` for SDK calls, `sdk` for input policy and geometry helpers, `text(value)` or `return` for selected results, and `await image(capture)` to show a capture reference as a bounded PNG.',
    'Use `text(api.help())` for the quick start, `text(api.search({ query: "window text" }))` to find methods, and `text(api.describe({ path: "WindowClient.findText" }))` for exact arguments, return fields, related types, and runnable examples. Search results are paginated. Read help before guessing a method or parameter.',
    `Core SDK signatures:\n${createApiHelp(catalog).help().starter.map(entry => entry.signature).join('\n')}`,
    'Example: const win = await auv.windows.resolve({ appName: "Counter" }); const found = await win.findText("Increment"); text(found.matches);',
    'Each tool call has fresh variables. `store(key, value)` and `load(key)` retain small JSON values only after successful calls. Save IDs, not SDK handles or pixels. Reconstruct a window with `await auv.windows.get(id)`.',
    'SDK calls support data arguments, including bigint IDs. Follow the exact types and examples: protobuf selectors and actions use nested case/value fields. Unknown fields can be omitted by SDK encoding. Callbacks, SDK async iterators and editor-only area/draw/focus helpers are not available in codemode yet.',
    'Intermediate SDK responses remain in the timeline. Emit only the evidence you need. Await every device call. A failed or canceled script does not undo delivered inputs.',
    'Successful execution and input delivery do not prove task success: read the relevant app state or show evidence to verify the requested result.',
    'Wait for a user task, then call codemode and iterate on its result. The human can inspect or stop your execution.',
  ].join('\n')
}
