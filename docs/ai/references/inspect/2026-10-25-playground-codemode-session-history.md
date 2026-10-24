# Playground codemode history and mock results

Date: 2026-10-25.
Change classification: bug fix.
Evidence: the owner's OpenCode conversation, source inspection, unit regressions, and browser integration with a synthetic ACP peer.

## History and desktop images

Every codemode call used the editor's per-run clear operation.
That operation erased calls and event positions, then advanced the run index.
Frame queries excluded captures from earlier indices.
With live view disabled, the canvas then showed its initial display image.
The mock scene retained its state throughout this process.

The browser reproduction delivered three Counter clicks, then made a metadata-only call.
Calls fell from eight to zero, and visible captures fell from one to zero.
A later query still returned `Count: 3`.

Codemode now appends calls and hook events to one timeline.
Event positions increase across executions.
Frame queries use the timeline identity, so the latest capture stays visible across calls.
Each SDK call retains its source script and source line offset.
The inspector displays that source, and editor queries exclude bindings and lines from other scripts.

Each execution still has a fresh VM and its own AUV Run.
Execution identity rejects results from an older execution after another one starts.
The final event batch commits before the next execution begins.
An editor run still starts a separate timeline, and Reset clears the workbench history.
These changes do not add chat persistence or replay of an entire agent session.

## Mock keyboard results

The mock scene only models Return or Enter submitting a Todo.
The Runner previously reported success for other keys without applying them.
It also accepted an empty keyboard sequence, including one produced by incorrect request fields.

The Runner now rejects unsupported keys and shortcuts with `UNIMPLEMENTED`.
Empty sequences, empty key combinations, and missing actions return `INVALID_ARGUMENT`.
It checks all actions before delivery, so an unsupported later action cannot leave earlier text in the scene.
Native key parsing and text editing remain outside this scene's implemented behavior.
The code marks that boundary beside the keyboard check.

## Help and capture errors

The help generator printed enum members as imported type names without numeric values.
It now reads enum declarations and includes each member's numeric value.
The VM also exposes `sdk.ScrollUntilStopReason`, including its numeric reverse mapping.

The observed five-step scroll was valid.
Four steps moved the viewport, and the fifth supplied the first no-motion result.
The default needs two consecutive no-motion results, so the five-step budget ended first.
`BUDGET_EXHAUSTED` is `3`; `TEXT_VISIBLE` is `2`.

The capture error previously called a response wrapper a `CapturedFrame`.
The SDK now tells callers to pass `response.capture`.
Accepted capture shapes and reference-based pixel retrieval stay the same.

## Regression evidence

- Store tests cover continued event positions, retained source, editor timeline replacement, and Reset.
- Timeline tests exclude other scripts from editor bindings and line highlights.
- Browser tests retain calls and frames across metadata-only executions, then append later SDK calls and inspect earlier source.
- Existing browser checks cover cancellation, timeout recovery, store rollback, image output, and editor VM isolation.
- Mock tests reject unsupported keys and empty sequences, and check that validation precedes all input effects.
- Help tests check numeric enum definitions and use the enum inside the VM.
- The SDK test passes a capture response wrapper and checks the actionable error before any transport call.

Validation passed: 94 Playground unit tests, 21 SDK driver tests, and the browser integration.
These checks use the mock desktop. They do not establish support for native keyboard input on a real device.
