# Playground session completeness review

Status: diagnosis complete. The owner approved the two small fixes described below.
The later [Agent presentation change](2026-10-25-playground-agent-ui.md) groups tool activity and keeps returned errors and screenshot previews visible.

NOTICE: The current `execute` tool description and SDK help supply execution instructions.
The [HTTP MCP contract](2026-10-25-playground-http-mcp-design.md) replaces the session briefing described in this review.

## Evidence

Reviewed OpenCode session `ses_e8e3d5327ffekFTXW1QUvtzb2x`,
“全面测试 AUV Playground 功能完整性”, on 2026-10-25.
The current page used ordinary OpenCode through Exterior's deployed HTTP MCP endpoint and the Mock desktop.
Evidence comes from the page's Calls, the visible chat, and the session's tool inputs, results, and nested call statuses.
No model reasoning or credentials form part of this diagnosis.

The session contains 52 outer OpenCode `execute` calls.
Its nested Playground calls comprise 47 successful scripts, six failed scripts,
and three calls rejected because another execution was running.
The first outer call never reached Playground: it used `text(api.help())` in OpenCode's own execution environment.
Six successful tool results contain image files.
The page retained 90 SDK Calls and 55 console entries.
Counter state advanced from zero to two, and the same ACP session read back the stored `{ n: 42 }` value.
No transport disconnection, VM crash, or history reset was observed in this session.

## Findings

### Agent test conclusions exceed the evidence

The agent enumerated 65 catalog entries but did not execute every entry.
The catalog also contains constants and geometry helpers.
Its store check tested separate calls in one ACP session, not persistence across ACP sessions.
One scroll check compared two different text queries without proving that the viewport changed.
`overlay.remove` did not run after `overlay.show` failed.
The report therefore cannot serve as a complete feature acceptance test.
Improve the test's coverage accounting and assertions rather than change the execution layer to match its claims.

### Parallel rejection is intentional, but its rule is not prominent

The agent launched six codemode calls with `Promise.allSettled`; three were rejected with
`Another playground execution is running.` The agent retried them sequentially.
`CodeModeHost` deliberately serializes a shared mutable desktop.
The tool description and `api.help().rules` did not tell the caller to serialize entire codemode invocations.
The tool description, API help, and session briefing now require sequential calls, including help queries.
Concurrent desktop execution remains outside this review's scope.

### Invalid display arguments silently select the primary display

The agent supplied `{ displayId: "2" }`, while the SDK accepts the nested protobuf selector.
The page recorded `selector: {}` and a capture from display one.
The correct nested selector reached display two and found its Increment text.
The SDK accepts a typed message initializer and protobuf encoding omits unknown fields.
Codemode erases TypeScript syntax; it does not run the TypeScript type checker.
The agent's claim that the shorthand always yields no matches is incorrect: it actually selects the default display.

This is an SDK argument-validation and usability concern with a wrong-target risk.
Any stricter runtime policy belongs at the shared SDK serialization contract.
Do not add a Playground-only shorthand or a second execution transport to handle this input.

### Chat hides the tool result and nested failure

The raw OpenCode result marks the nested `auv-playground.codemode` call as `error` for failed scripts.
Its outer `execute` call still completes because that wrapper returned the error as a result.
`AgentThread.tsx` previously rendered only `toolName`, the outer status, and truncated `argsText`.
It did not render the tool result or the nested error metadata.
Each tool row now expands to show its complete input and ACP content, including text and image results.
Raw output remains inspectable, including nested statuses supplied by the agent.
The wrapper retains its own completion status; result text does not determine that status.
This is a Playground Agent UI issue, not evidence that codemode lost its error result.

### Parameter mistakes and Mock limits do not require a transport fix

The agent passed the wrong capture wrapper to `recognizeText`, omitted the `scrollUntil.step` wrapper,
and used `actions` instead of `keyboard.inputs` with the required action and recipient structure.
Each failed clearly; consulting `api.describe` allowed the corrected calls to succeed.
The initial confusion between OpenCode's own runtime and Playground's runtime also recovered on the next call.

Mock permission probing, overlay display, and the direct `InputService/PressKeys` RPC returned UNIMPLEMENTED.
The existing window keyboard route works for Return or Enter; broader Mock keyboard behavior is explicitly deferred.
These results do not establish a failure on a real device and do not justify implementing every platform API in Mock.

## Priority

No urgent codemode runtime or HTTP MCP regression was found.
The serial-invocation rule and inspectable tool results with nested errors are implemented.
Handle strict SDK argument validation as a separate shared-contract decision.
Correct the agent's acceptance-test method before treating its coverage claims as evidence.

## Regression evidence

The browser harness sends ACP tool updates for a completed wrapper with a failed nested codemode result.
The fixture follows the installed OpenCode 2.0.26 projector: metadata goes to `rawOutput.metadata`, and image files become ACP image content.
Before the fix, the check failed because the tool row had no expandable input or result.
The check now requires the full input, failure text, nested error metadata, and the wrapper's unchanged completion status.
It also requires an ACP image result to decode as an image.
The existing connection, session, HTTP MCP, VM, and continuous-history checks remain in the same harness.

Validation passed in `apps/repl-playground`:

- All 99 tests across 17 files.
- TypeScript type checking.
- ESLint for the five changed source and harness files, with no warnings.
- Vite production build.
- `node agent/verify-browser.mjs`, including the tool-result regression.
- `git diff --check` from the repository root.
