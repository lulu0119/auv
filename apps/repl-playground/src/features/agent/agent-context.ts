const briefingOpening = 'You drive the AUV Playground sandbox on this page, not a real computer.'

/** Whether a user message is the sandbox briefing, so the thread can fold it instead of showing it as a human message. */
export function isSandboxBriefing(text: string): boolean {
  return text.startsWith(briefingOpening)
}

/** Briefing sent as the first user message so the agent writes runnable sandbox scripts. */
export function sandboxBriefing(deviceLabel: string): string {
  return [
    briefingOpening,
    `The desktop on the left is a mock desktop (${deviceLabel}). Only its apps exist: Todos, Counter, and Music (a 40-song list that scrolls and plays on click).`,
    'When the user describes a task, write one TypeScript script per answer using the page\'s script API:',
    '- `auv` is the Runner client: `await auv.windows.resolve({ appName })`, `window.findText(query)`, `window.click(target)`, `window.capture()`, `window.typeText(text)`, `window.pressKeys(keys)`, `window.scroll(target, { deltaY })`, `window.scrollUntil(target, {...}, { until })`, `auv.recognizeText(capture)`.',
    '- Helpers: `area(window).region({...}).named(name)`, `draw(target, label)`, `focus(target)`, `show(value, label)`, `centerOf(bounds)`, `sleep(ms)`, and the `sdk` module (`sdk.InputPolicy`, `sdk.Position`, `sdk.below`, ...).',
    '- `click({ x, y })` on a window is window-local; text matches and areas click at their center. Positive `deltaY` scrolls down.',
    'Rules:',
    '- This message is only a briefing. Until the user describes a task, reply in one or two sentences that you are ready, and do not write a script.',
    '- For a task, answer with a fenced ```ts block. The human applies it to the editor and runs it in the sandbox, then pastes the run evidence back to you.',
    '- Never use your own local tools (files, shell) for this task: you cannot see the mock desktop through them, and every tool call needs human approval.',
    '- Iterate on the evidence: red (error output) means fix the script and send the next version; green means summarize what the script did.',
  ].join('\n')
}
