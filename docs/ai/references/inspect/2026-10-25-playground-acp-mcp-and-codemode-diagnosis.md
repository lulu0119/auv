# Playground ACP MCP and codemode diagnosis

Status: historical transport record. The codemode bug evidence remains relevant.
The [HTTP MCP migration](2026-10-25-playground-http-mcp-design.md) replaces the native ACP MCP transport and local agent wrapper.

## Scope and evidence

The owner approved native MCP over ACP and requested causes before fixes.
Product decisions must stop for owner confirmation.
This change is an approved transport feature plus reproduced bug fixes.

The report inspected OpenCode session `ses_e8f06385dffe9kHaY00j3kVNGj`,
“AUV Playground 复杂压力测试与问题排查”.
Only user text, assistant text, tool arguments, and tool results were read.

Evidence levels:

- Unit regressions cover VM execution, transport, cancellation, and initialization retry.
- Browser integration uses real workers, the SDK, a synthetic ACP peer, and the Mock Runner.
- A live OpenCode 2.0.26 process completed initialization, session creation, and MCP tool discovery through the new adapter.
- That live check sent no model prompt. It does not prove remote Relay transport or task completion.
- The current user tab could not be inspected because browser automation timed out.

## Transport contract

The browser supplies `{ type: 'acp', name, serverId }` in `session/new.mcpServers`.
The peer must advertise `agentCapabilities.mcpCapabilities.acp`.
Each operation uses `mcp/message` with a server ID and a separate logical request ID.
Required inner metadata declares MCP `2026-07-28` and client capabilities.
There is no native MCP initialization handshake.

The browser serves the codemode tool catalog and executes tool calls.
An ACP response carries an inner MCP result or error.
Binding errors remain outer ACP errors.
Cancellation targets the outer request through `$/cancel_request`.
Unrelated ACP requests and cancellations still reach the UI SDK.

OpenCode 2.0.26 advertises HTTP MCP, not native ACP MCP.
`agent/proxy.mjs` adapts its HTTP tool client at the agent boundary.
It terminates the legacy HTTP initialization exchange and forwards operations through native ACP MCP.
The browser protocol and tool definitions are independent of that adapter.
Native-capable agents bypass the adapter.

This is a tool transport adapter for the current Playground server.
It is not evidence of full optional MCP conformance.
Streaming MCP notifications remain deferred until an approved tool needs them.
Native ACP MCP is experimental; its explicit protocol metadata defines this compatibility boundary.

## Confirmed codemode defects

### Large arrays failed during teardown

The test created a 300,000-element array and printed its length successfully.
QuickJS then failed its `JS_FreeRuntime` GC assertion.
The same source succeeded when compiler inspection hooks were absent.

The binding hook dumped the full guest value before the worker applied its inspection summary.
The fix summarizes values inside the guest with the existing shared serializer.
Arrays cross the inspection boundary as at most 500 items.
The 64 MiB VM limit stays unchanged.
Both the unit reproduction and a browser test with one million elements pass.

This evidence identifies the triggering boundary.
It does not establish every internal cause of QuickJS's C-level assertion.

### BigInt SDK IDs were rejected

The guest argument validator used `JSON.stringify`, which rejects BigInt values.
Valid SDK arguments such as `{ mouse: 0n }` therefore failed before reaching the SDK.

The bridge now preserves BigInt values through typed VM handles.
Text output represents BigInt IDs as decimal strings without precision loss.
The session store still accepts JSON data only.
Callbacks and async iterators remain unavailable.
The admitted SDK constants now include `MouseButton`.

### Pure scripts required a device

The missing-device proxy threw on every property read.
Returning it from an async function read `then` before user code started.
VM setup also read `auv.windows.from` eagerly.

The worker now constructs the ordinary lazy SDK client.
The host bridge rejects actual device operations when no backend is ready.
Pure expressions and API help can run without a device.

Device restoration also cached its rejected Promise indefinitely.
The cache now clears after failure, so a later explicit retry can succeed.
The original page's first missing-backend trigger remains unproven.

### Heavy inspection makes CPU loops slow

Before the fix, 100,000 iterations generated 100,003 async step calls and 100,001 binding calls.
Each async step also allocated a VM promise retained until execution ended.

Codemode now uses synchronous recording hooks.
Completed bridge promises release their host handles promptly.
Full statement and binding history still makes a million-iteration browser loop exceed ten seconds.
That remaining behavior has not been fixed or presented as passing.

The owner declined SDK/output-boundary sampling and retained complete statement and binding history.
The remaining CPU-loop cost stays a known limitation.
The editor's debugger behavior stays unchanged.

Run the red performance reproduction explicitly:

```powershell
$env:AUV_CODEMODE_BENCHMARK = '1'
node agent/verify-browser.mjs
Remove-Item Env:AUV_CODEMODE_BENCHMARK
```

The normal browser check does not claim this performance case passes.

## Other stress-test findings

| Reported behavior | Cause and disposition |
| --- | --- |
| Display 2 requests returned display 1 | The test passed `{ displayId: '2' }`, outside the SDK selector shape. Encoding omitted that field. The correct nested selector reaches display 2 in browser integration. Runnable examples were added. |
| Negative capture dimensions returned a tiny image | Mock rendering clamped dimensions while metadata kept negative values. The Mock Runner now rejects them before rendering. |
| Empty or whitespace text queries returned matches | Mock substring matching differed from shared OCR behavior. It now returns no matches for an empty normalized query. |
| `click(match.bounds)` failed | A bare rectangle has `x/y` and is treated as a window-local point. Pass the match, `{ bounds: rect }`, or an explicit screen position. |
| String mouse buttons failed encoding | The SDK takes numeric enums. Use `sdk.MouseButton.LEFT`, not `'left'` or `'LEFT'`. |
| `scrollUntil` reported delta errors first | The test omitted the required scroll step. Its condition also supplied a string instead of `{ query }`. These results do not establish a budget validation defect. |
| `from('bad-id')` succeeded while `get` failed | `from` binds without IO. `get` verifies existence through a fresh listing. Both match the SDK contract. |
| Empty text input succeeded | The scene appends an empty string, which is a no-op. No contract requires an error here. |
| `typeText` with 100,000 characters timed out | The Mock Runner simulates `15 * text.length / 4` milliseconds of typing: 375 seconds for this input. The default codemode deadline is 30 seconds. This is not evidence of a VM serialization failure. |
| Missing `click` argument produced an internal TypeError | Invalid SDK use currently reaches `positionOf`. This is an SDK diagnostic issue, not a codemode transport failure. |
| `keyboard` actions failed | The test omitted the `action` wrapper and used the wrong target shape. A runnable SDK example was added. |
| Parallel codemode was rejected | Execution shares one mutable desktop. The host deliberately serializes admission; no queue or parallel execution was added. |
| `setTimeout` was absent | The VM admits selected functions only. Timer/callback marshalling is outside the current interface. |
| Several methods returned `UNIMPLEMENTED` | The Mock Runner models selected desktop behaviors. The SDK catalog describes signatures, not device support. |

The compiler strips TypeScript syntax; it does not type-check each agent script.
Incorrect object shapes can therefore reach SDK encoding.
The fix adds concrete examples and explains this boundary instead of duplicating SDK argument validation throughout codemode.

## Validation

Run from `apps/repl-playground`:

```sh
node ../../node_modules/vitest/vitest.mjs run
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node agent/verify-browser.mjs
```

The browser check covers native tool discovery and the HTTP adapter path.
It also covers device-free help, correct display selection, large arrays, mock validation,
history preservation, cancellation, timeout recovery, store rollback, and editor isolation.

## Primary references

- [Native MCP-over-ACP](https://agentclientprotocol.github.io/rust-sdk/mcp-over-acp.html)
- [Native wire binding](https://agentclientprotocol.github.io/rust-sdk/protocol.html#native-mcp-over-acp)
- [Official HTTP compatibility boundary](https://github.com/agentclientprotocol/rust-sdk/blob/main/md/mcp-bridge.md)
