# inspect

AUV tracing, run storage, artifact delivery, and inspect viewer contracts

Count: **24**

## Current

- [`2026-10-25-playground-agent-ui.md`](2026-10-25-playground-agent-ui.md)
  (OpenCode desktop reference, compact Agent activity, returned errors,
  visible screenshots, and preserved execution details)

- [`2026-10-25-playground-session-completeness-review.md`](2026-10-25-playground-session-completeness-review.md)
  (latest Mock test evidence, agent coverage overclaims, serial invocation guidance,
  SDK selector mistakes, and hidden nested tool errors)

- [`2026-10-25-playground-http-mcp-design.md`](2026-10-25-playground-http-mcp-design.md)
  (Exterior-hosted HTTP MCP, browser execution ownership, connection lifetime,
  and live remote Relay evidence)

- [`2026-10-25-playground-acp-mcp-and-codemode-diagnosis.md`](2026-10-25-playground-acp-mcp-and-codemode-diagnosis.md)
  (historical ACP transport, VM marshalling and startup fixes,
  stress-test diagnosis, and retained complete statement history)

- [`2026-10-25-playground-codemode-session-history.md`](2026-10-25-playground-codemode-session-history.md)
  (continuous codemode history and desktop frames, source attribution,
  honest mock keyboard results, and numeric enum help)

- [`2026-10-23-exterior-eap-sdk-migration.md`](2026-10-23-exterior-eap-sdk-migration.md)
  (EAP v1 SDK, app setup registration, development and release identities,
  account methods, and live verification limits)

- [`2026-10-20-exterior-adapter-research.md`](2026-10-20-exterior-adapter-research.md)
  (Exterior package contract, device discovery, OAuth callback, tickets,
  agent working directories, custom proxy setup, and source evidence)

- [`2026-10-20-codemode-agent-interface-research.md`](2026-10-20-codemode-agent-interface-research.md)
  (source comparison of Pi, OpenCode V2, and Playground codemode execution,
  SDK discovery, signatures, and results)

- [`2026-10-14-playground-codemode-design.md`](2026-10-14-playground-codemode-design.md)
  (playground-owned codemode for ACP agents: MCP proxy, isolated execution,
  explicit output, session state, cancellation, and browser mock evidence)

- [`2026-07-26-tracing-write-pipeline.md`](2026-07-26-tracing-write-pipeline.md)
  (current producer-side `auv-tracing` contract and implementation handoff)

This contract wins if a historical record conflicts with it.

- [`2026-10-21-trace-and-log-responsibility-split.md`](2026-10-21-trace-and-log-responsibility-split.md)
  (accepted direction: which layers record traces, which write operational
  logs, and why drivers do neither; Runner-side recording for the SDK path,
  nested command and Runner RPC spans, expiring per-user log files)

- [`2026-10-08-playground-sdk-transport-design.md`](2026-10-08-playground-sdk-transport-design.md)
  (accepted: playground scripts on `@auv-js/sdk` over an eventa transport
  bridge; RPCs drawn by message type, replayed at the transport, and captures
  previewed by ThumbHash; behind `sdk` / `device`)

## Historical / Superseded Pre-V1 Records

These documents are retained for historical context and are not normative.
The 2026-07-17 document is preserved research and repository audit material.

- [`2026-05-19-trace-run-inspect-design.md`](2026-05-19-trace-run-inspect-design.md)
- [`2026-05-19-trace-run-inspect-implementation-plan.md`](2026-05-19-trace-run-inspect-implementation-plan.md)
- [`2026-05-21-live-inspect-recording-design.md`](2026-05-21-live-inspect-recording-design.md)
- [`2026-06-10-tracing-driver-runtime-recording-split.md`](2026-06-10-tracing-driver-runtime-recording-split.md)
- [`2026-06-18-recording-root-shim-removal-plan.md`](2026-06-18-recording-root-shim-removal-plan.md)
- [`2026-06-18-recording-root-shim-removal-spec.md`](2026-06-18-recording-root-shim-removal-spec.md)
- [`2026-07-10-inspect-server-crate-viewer-implementation-plan.md`](2026-07-10-inspect-server-crate-viewer-implementation-plan.md)
- [`2026-07-10-inspect-server-crate-viewer-spec.md`](2026-07-10-inspect-server-crate-viewer-spec.md)
- [`2026-07-13-inspect-composition-s4-migration.md`](2026-07-13-inspect-composition-s4-migration.md)
- [`2026-07-17-auv-tracing-contract-and-invoke-output-design.md`](2026-07-17-auv-tracing-contract-and-invoke-output-design.md)
- [`2026-07-20-auv-run-recording-contract-v1-spec.md`](2026-07-20-auv-run-recording-contract-v1-spec.md)
- [`2026-07-20-auv-run-contract-v1-implementation-plan.md`](2026-07-20-auv-run-contract-v1-implementation-plan.md)

## Related

- Parent index: [`../INDEX.md`](../INDEX.md)
- Docs overview: [`../../../README.md`](../../../README.md)
- Shared vocabulary: [`../../../TERMS_AND_CONCEPTS.md`](../../../TERMS_AND_CONCEPTS.md)
