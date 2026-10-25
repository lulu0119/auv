# Playground standard HTTP MCP

Status: implemented with Exterior's relay-hosted MCP endpoints.
The owner approved this route after Exterior PR #44 merged and deployed.
This is an approved transport migration; VM execution and recording retain their existing contract.

## Current contract

The Playground uses `@exterioragentprotocol/sdk` at immutable revision
`aec6c44ae53b0a896f7b206a0e3b4a56a73fbc7e`.
A connection attempt calls `serveMcp` with a live account access token.
Exterior returns an agent-reachable HTTP MCP URL and its authorization headers.
The page connects a fresh MCP SDK `Server` for each MCP session.
`CodeModeHost` owns the tool definition, execution, cancellation, and session store.

The ACP `session/new` request receives:

```ts
{
  type: 'http',
  name: 'auv-playground',
  url: tools.url,
  headers: tools.headers,
}
```

The agent must advertise `agentCapabilities.mcpCapabilities.http`.
Tool discovery can finish before ACP session creation returns.
Execution requires an active Playground ACP session.
The MCP SDK handles initialization, tool requests, and cancellation notifications.
The browser no longer handles experimental `mcp/message` requests.
The agent device runs its ordinary ACP agent, without a Playground startup wrapper.

Exterior owns endpoint credentials, HTTP transport, browser routing, and relay cleanup.
AUV owns the tool and its selected device, Mock desktop, store, and timeline.
The Playground remains a static deployment, including its current assets-only Worker.
Neither a public browser listener nor an AUV application backend is required.

## Connection lifetime

Each ACP connection attempt opens its own MCP endpoint before the ACP socket starts.
Both end together when the adapter aborts or its ACP stream closes.
The endpoint is created inside the adapter factory: React StrictMode discards one
connection attempt during development, and its cleanup must not close the next attempt's endpoint.
A browser integration test reproduced that failure before the ownership change.

One endpoint belongs to one ACP connection, following Exterior's SDK contract.
Agents may share supplied MCP servers between ACP sessions in the same process.
The Playground therefore binds execution to its active session and resets its JSON store on session replacement.
Request cancellation uses a unique invocation id because MCP request ids can repeat between transports.

The migration preserves these execution rules:

- A call gets fresh VM variables.
- Calls, screenshots, outputs, and full statement and binding history append across calls.
- The Mock desktop remains active across calls.
- Successful calls commit the JSON store; failed or canceled calls do not.
- SDK input already delivered is not rolled back.
- One mutable desktop runs one script at a time.
- The editor keeps its separate REPL state.

Streaming tool progress, SDK callbacks, and async iterators remain deferred at their existing code markers.
Complete script recording retains the previously documented CPU-loop cost.

## Evidence

Evidence level: automated browser integration with the actual VM, SDK, and Mock Runner.
`node agent/verify-browser.mjs` uses a synthetic Exterior MCP wire peer and real MCP HTTP transports.
It covers HTTP tool discovery before ACP session creation, execution, cancellation,
timeout recovery, store rollback, retained Calls and captures, source history,
editor isolation, StrictMode connection setup, live account token use, and unsupported-agent handling.
Unit tests also exercise the MCP host with the MCP SDK's real client and linked transports.

Evidence level: live remote Relay and ordinary local OpenCode 2.0.26, with model inference.
The actual Playground page connected to `https://relay.apps.superpowerlulu.win`.
The agent completed two codemode calls through the deployed endpoint:
the first clicked the Mock Counter, stored a marker, and emitted a screenshot;
the second read that marker, reported the first call's variable as undefined,
and emitted a second marker. The page retained five SDK Calls and all five output entries.
This verifies browser execution through the remote Relay, not a physical desktop workflow.
An agent on a separate physical device was not tested.

The local Exterior CLI was reinstalled from the same immutable revision and its daemon restarted.
Existing device identity and saved sign-in were retained.
The ordinary `opencode` slot remains; the obsolete `auv-playground` wrapper slot was removed.

## Sources

- [Exterior PR #44](https://github.com/lulu0119/exterior/pull/44)
- [Exterior SDK serving tools](https://github.com/lulu0119/exterior/blob/aec6c44ae53b0a896f7b206a0e3b4a56a73fbc7e/packages/sdk/README.md#serving-tools-to-an-agent)
- [Exterior decision](https://github.com/lulu0119/exterior/blob/aec6c44ae53b0a896f7b206a0e3b4a56a73fbc7e/docs/adr/0030-a-web-app-serves-mcp-through-the-relay.md)
- [ACP MCP server configuration](https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers)
- [Earlier codemode diagnosis](2026-10-25-playground-acp-mcp-and-codemode-diagnosis.md)
