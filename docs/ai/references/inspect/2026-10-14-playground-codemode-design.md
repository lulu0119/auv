# Playground codemode

## Execution contract

The Playground supplies one `codemode({ code, timeoutMs })` MCP tool to an ACP agent.
The browser executes each call against its selected AUV Device or mock desktop.
The agent receives explicit output and execution status through the tool response.

An app-owned proxy starts the configured ACP executable on the agent device.
It supplies a loopback HTTP MCP server to new ACP sessions.
The underlying agent must advertise HTTP MCP support.
The browser and proxy negotiate `_meta.auv.codemode = 1` during initialization.
Tool calls use `_auv/codemode` reverse requests on the ACP connection.
Connections require this extension before the UI starts a session.

Each call uses a temporary Worker with a fresh QuickJS/WASM context.
The guest has a 64 MiB memory limit and no filesystem, network, or browser globals.
The compiler erases TypeScript syntax and instruments JavaScript for the timeline.
The editor REPL has a separate Worker and retains its own variables.

Scripts receive `auv`, admitted `sdk` helpers, `api`, `text`, `image`, and `store/load`.
SDK resource methods remain callable on returned objects, including `WindowClient`.
Only explicit text/image output and execution status return to the agent.
SDK calls and intermediate results remain available in the shared timeline.

`store/load` holds bounded JSON data in the active ACP session.
Successful calls commit writes. Failed or canceled calls preserve the committed store.
Session replacement clears the store and cancels active execution.
Stop, timeout, and disconnect cancel active execution and pending SDK work.
Delivered inputs remain effective after cancellation or failure.
Successful execution does not prove semantic task success; app state supplies that evidence.

## Connection adapter and workbench

`src/features/agent/exterior.ts` owns the concrete Exterior connection adapter.
It supplies relay configuration, authentication, callback routes, device discovery, and one-time tickets.
The ACP consumer accepts `{ url, label, cwd }` without an Exterior dependency.
The adapter supplies the agent device's `workingDirectory` as `cwd`.
The agent device and selected AUV Device are independent.

The adapter uses `@exterior/client`, `@exterior/client/react`, and `@exterior/contract`.
`VITE_EXTERIOR_URL` selects the relay origin; the default is `http://127.0.0.1:8787`.
The callback is under the `/playground/` application base path.
See the [Exterior connection contract](2026-10-20-exterior-adapter-research.md)
for package pins, device fields, ticket behavior, and CLI configuration.

The workbench has three columns: Desktop, Agent/Script, and Inspector.
Calls, console, variables, and the timeline are shared below those columns.
Agent and Script panels stay mounted across tab switches.
The ACP connection, chat, CodeMirror editor, and editor REPL state stay active.
Each connection starts a fresh agent process and ACP session.
Each session receives environment instructions with its first user prompt.

## API help

The agent can query metadata inside codemode without a device call:

```ts
text(api.help())
text(api.search({ query: 'window text', limit: 5 }))
text(api.describe({ path: 'WindowClient.findText' }))
```

`api.help()` returns execution rules, resource limits, and starter signatures.
`api.search()` returns exact SDK paths, signatures, descriptions, and pagination offsets.
`api.describe()` returns exact argument and return types, related types, examples, and restrictions.
A related type name also works as a describe path.

`agent/help-catalog.ts` generates the catalog from SDK TypeScript declarations and documentation.
`src/script-api/codemode-sdk.ts` defines the admitted SDK helpers.
The briefing and VM share this JSON catalog.
SDK source edits invalidate the development catalog.
SDK type errors stop catalog generation.
Vite prebundles compiler and VM dependencies to keep the page connected during execution.

## Boundaries

Callbacks and async iterators cannot cross the VM interface.
Search omits those methods; exact describe queries explain their restrictions.
SDK help describes call contracts. The selected device determines platform support.
Live Runner documentation describes RPCs and needs an explicit mapping to ergonomic SDK methods.

`image(capture)` accepts an AUV capture reference and fetches bounded pixels on the host.
Pixels remain outside the VM and session store.
MCP results expose text/image content and `isError`.
Execution status and failure location appear in the final text item.

The editor displays agent source for inspection.
Run, stepping, replay, and editor types use the editor REPL environment.
Codemode helpers are available through agent tool calls.
Interactive ACP authentication, chat persistence, and a directory picker are unavailable.
Connection retries obtain fresh tickets, with two automatic attempts during startup.

## Validation

Evidence level: automated integration with a synthetic ACP peer and mock Runner.
The package checks cover API help, VM execution, transport, cancellation, and state isolation.
The browser check discovers `findText`, reads help, and executes the returned example.
Metadata queries make zero device calls.

The browser also finds Increment, delivers three clicks, and reads `Count: 3`.
It emits bounded PNG/JPEG images and records eight successful SDK calls.
Checks cover partial output, store rollback, timeout recovery, and editor REPL state.
The connection UI uses synthetic Exterior account, device, and ticket responses.
Checks cover device working directories, session briefings, tab state, and unsupported connections.
The viewport checks use widths of 1440 and 1024 pixels.
Live Exterior OAuth, daemons, and LLM task completion are outside this evidence.

- [Browser check output](evidence/2026-10-20-codemode-help/browser-check.txt)
- [Connected Agent layout](evidence/2026-10-20-codemode-help/agent-connected.png)
- [Script and call timeline](evidence/2026-10-20-codemode-help/script-timeline.png)
- [1024-pixel layout](evidence/2026-10-20-codemode-help/agent-1024.png)

```sh
pnpm -F @auv-js/repl-playground test:run
pnpm -F @auv-js/repl-playground typecheck
pnpm -F @auv-js/repl-playground lint
pnpm -F @auv-js/repl-playground build
pnpm -F @auv-js/repl-playground test:browser
```

## References

- [Agent interface source comparison](2026-10-20-codemode-agent-interface-research.md)
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
