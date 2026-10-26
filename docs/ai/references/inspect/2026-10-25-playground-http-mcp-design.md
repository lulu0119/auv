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

`codeModeConnection` adapts the typed `AcpClientConnection` interface.
It supplies the MCP endpoint through `newSession`, adds the first-prompt briefing, and forwards cancellation.
The ACP SDK owns message parsing and request matching.
The controller owns negotiated capabilities, connection errors, and active-session selection.
Session creation updates controller state directly; the Playground does not refresh an unused session list.

Exterior owns endpoint credentials, HTTP transport, browser routing, and relay cleanup.
AUV owns the tool and its selected device, Mock desktop, store, and timeline.
The Playground remains a static deployment, including its current assets-only Worker.
Neither a public browser listener nor an AUV application backend is required.

## Connection lifetime

The Connect action creates an `AcpThreadController` in `agent-session.ts`.
The page owns this controller. React views subscribe to it and project its state.
Mounting or unmounting a view does not open or close a connection.
Disconnect and Reconnect dispose the current controller. A page reload closes its sockets.

The adapter prepares the MCP endpoint before requesting the single-use ACP ticket.
The ticket therefore does not wait for MCP setup.
The endpoint closes when startup fails, the controller aborts, or the ACP connection closes.
Canceled startup cannot update a replacement connection.

`useAcpControllerRuntime` projects an existing controller without managing its connection.
The local patch `patches/@hafbit__react-acp@0.1.9.patch` exposes the package's existing projection through this hook.
Remove the patch when an upstream release exports this interface.

The earlier integration used `useAcpRuntime`, which connects and disconnects from mount effects.
Those effects could destroy the agent behind a single-use ticket during a view remount.
Automatic ticket retries treated real startup failures as development lifecycle failures.
The current path has no automatic ticket retry and creates the initial ACP session from the Connect action.
StrictMode remains enabled and does not create discarded MCP endpoints.

One endpoint belongs to one ACP connection, following Exterior's SDK contract.
Agents may share supplied MCP servers between ACP sessions in the same process.
The Playground therefore binds execution to its active session and resets its JSON store on session replacement.
Request cancellation combines the MCP request signal with the active execution signal.
Signals belong to individual invocations, so cancellation cannot affect a call from another transport with the same request id.

The migration preserves these execution rules:

- A call gets fresh VM variables.
- Calls, screenshots, outputs, and full statement and binding history append across calls.
- The Mock desktop remains active across calls.
- Successful calls commit the JSON store; failed or canceled calls do not.
- SDK input already delivered is not rolled back.
- One mutable desktop runs one script at a time.
- The editor keeps its separate REPL state.

The VM validates each store update before replacing its local state.
It returns the state only after success, so the input store remains unchanged.

Streaming tool progress, SDK callbacks, and async iterators remain deferred at their existing code markers.
Complete script recording retains the previously documented CPU-loop cost.

## Evidence

Evidence level: automated browser integration with the actual VM, SDK, and Mock Runner.
`node agent/verify-browser.mjs` uses a synthetic Exterior MCP wire peer and real MCP HTTP transports.
It covers HTTP tool discovery before ACP session creation, execution, cancellation,
timeout recovery, store rollback, retained Calls and captures, source history,
editor isolation, live account token use, and unsupported-agent handling.
The lifecycle fixture also rebuilds the entire React view under StrictMode after connection.
It requires the same ACP socket, MCP endpoint, and single-use ticket to remain valid.
Startup failures remain visible without automatic replacement agents. Explicit reconnect requests a fresh ticket.
The fixture also cancels startup during the ticket request and immediately connects again.
Only the replacement opens an ACP socket, and the canceled request cannot replace its state.
Unit tests also exercise the MCP host with the MCP SDK's real client and linked transports.

The 2026-10-26 simplification passed all 101 unit tests, TypeScript checking, the production build, changed-file ESLint, and the browser harness.
The unit tests use the real ACP adapter and controller for session setup, briefing, cancellation, and connection cleanup.
The browser harness also rejects session-list requests when the agent does not advertise that capability.

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
