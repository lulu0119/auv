# Playground Agent presentation

Status: implemented and verified with the browser harness and a live remote Relay session.
The owner requested changes inside the Agent module, with OpenCode desktop as the reference.
The previous HTTP MCP migration and tool-details UI are saved in commit `569c1e11`.

## Evidence and scope

A live Mock task on 2026-10-25 asked the agent to set Counter to two and verify with a screenshot.
It succeeded, but produced 16 identical `execute complete` rows, 21 SDK Calls, and 15 Console entries.
The first completed wrapper contained a ReferenceError.
The final screenshot required opening a tool row and scrolling past escaped script input.
At 1280 by 720, the chat viewport had about 300 pixels of height.

This is an approved Agent UI feature.
Only Agent presentation, its browser regression, and supporting documentation change.
The desktop canvas, workbench panel layout, Calls, Console, tracing, transport, and VM lifecycle retain their existing behavior.

## OpenCode reference

Reference revision: `anomalyco/opencode@32b57015e5b491a789fba1534ecb472e676c9d8e`.
The desktop groups adjacent tool activity and uses compact triggers with optional details.
Its code-mode error presentation checks structured metadata even when an execute wrapper completed.

- [Tool groups and execute presentation](https://github.com/anomalyco/opencode/blob/32b57015e5b491a789fba1534ecb472e676c9d8e/packages/session-ui/src/tools/tool-renderer.tsx)
- [Code-mode failure metadata](https://github.com/anomalyco/opencode/blob/32b57015e5b491a789fba1534ecb472e676c9d8e/packages/session-ui/src/message/current-tool-state.ts)
- [Compact expandable triggers](https://github.com/anomalyco/opencode/blob/32b57015e5b491a789fba1534ecb472e676c9d8e/packages/session-ui/src/components/basic-tool.tsx)

## Presentation contract

The provisional UI label "activity" groups adjacent tool calls within one assistant message.
Narration retains its position; grouping does not combine separate messages or reorder events.
Collapsed activity shows a count, reported tool titles, and a count of returned errors.
It does not claim semantic task success or invent step names from script text.

Images and short error previews remain visible outside the folded tool list.
Image previews use the bounded ACP image content already returned to the agent.
Opening a preview shows that same image in a keyboard-accessible dialog and requests no additional pixels.

Execution details show the result before optional script and protocol sections.
Scripts retain their original text without JSON string escaping.
The full raw input, raw output, and original ACP status remain inspectable.

Returned error presentation uses these explicit signals:

- ACP status `failed`.
- A string in `rawOutput.error`.
- OpenCode's boolean `rawOutput.metadata.error`.
- OpenCode's nested `rawOutput.metadata.toolCalls[].status === "error"`.

Output text never determines error status.
"Finished" means the execution returned, not that the user's task was verified.
Business verification and links from Agent steps to recorded SDK Calls require a separate approved association contract.
The current UI does not infer these links from script text, timing, or output strings.

The composer uses task-focused copy, a compact connection indicator, and the existing new-session action.
The upstream chat primitive supplies a jump-to-latest control that respects manual history reading.

Assistant text and reasoning use the `@assistant-ui/react-markdown` MarkdownText composition with `remark-gfm`.
The library owns parsing, streamed text, and code-fence extraction.
The local adapter applies the existing theme, scrolls wide tables, and reuses the shared clipboard helper for code copies.
Tool protocol data and scripts remain plain text in their detail sections.

The acceptance session also exposed misleading VM guidance.
Its `Array.map` callback worked locally, but `raw: windowClient` included SDK method functions in the value passed to `text()`.
The shared boundary validator reported an unsupported SDK callback, which led the agent to blame `map`.
The error now names the function boundary, and help shows how to output each client's `id` and `window` metadata.
Function transport remains unsupported; execution and state rules are unchanged.

## Validation

The browser regression first failed against the checkpoint UI because no activity group existed.
It exercises two completed wrappers with returned errors, an image result, and harmless text containing "errors".
Required checks cover collapsed error visibility, screenshot access, dialog dismissal, readable scripts, and unchanged protocol status.
It also checks connection retention, session changes, and fitting the workbench at 1280 by 720.

Validation passed:

- All 101 unit tests across 17 files, including local map callbacks, function-bearing output, and executable help examples.
- TypeScript type checking and the Vite production build.
- ESLint for the changed Agent source and browser harness, with no warnings.
- The browser harness, including returned-error metadata, harmless error-related text, image decoding, dialog dismissal, and script inspection.
- Six-column Markdown tables, task lists, strikethrough, links, quotes, and fenced-code copying in the actual ACP message renderer.
- `git diff --check`.

The browser fixture below shows grouped tool calls, deliberate errors, a screenshot preview, and a Markdown report table.
It uses synthetic ACP responses and the Mock desktop.

![Agent UI browser fixture](evidence/2026-10-25-agent-markdown/agent-markdown.png)

The live probe used ordinary OpenCode 2.0.26 through the configured remote Exterior Relay.
It set the Mock Counter from zero to two and returned a window screenshot showing Count: 2.
Nine agent tool calls appeared as two adjacent activity groups, with four and five calls.
The screenshot thumbnail remained visible while its activity was folded; opening and closing the preview worked.
The workbench retained all 17 SDK Calls and ten Console entries from this probe.
This single live task is integration evidence, not a claim about other agents or device capabilities.
