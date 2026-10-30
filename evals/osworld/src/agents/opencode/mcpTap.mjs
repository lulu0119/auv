import process from 'node:process'

// Stdio tap between an MCP client (opencode) and the AUV MCP server.
//
// Usage: node mcpTap.mjs <server command> [args...]
//
// Forwards JSON-RPC lines in both directions and appends each one, with its
// direction and time, to `OSWORLD_MCP_TAP_FILE`. The opencode harness reads
// the log to recover the exact AUV calls a model made, which Code Mode hides
// inside `execute` scripts.
//
// Observe after action: when a model's AUV input or app command succeeds, the
// tap captures the display, reads the image through `artifact_read_image`,
// and appends it to that command's result before forwarding it, the policy
// `src/agents/pi/runAgent.ts` applies (`OSWORLD_OBSERVE_AFTER_ACTION`, default
// on). AUV itself returns image references only; the screenshot is the eval's
// choice. The log keeps the server's original response; the tap's own calls
// are logged as `tap_to_server` / `server_to_tap`.
//
// NOTICE: Image `data` fields are replaced by their length in the log only.
// One capture is megabytes of base64.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

const [command, ...args] = process.argv.slice(2)
const tapFile = process.env.OSWORLD_MCP_TAP_FILE
if (command == null || tapFile == null) {
  process.stderr.write('Usage: OSWORLD_MCP_TAP_FILE=<log> node mcpTap.mjs <command> [args...]\n')
  process.exit(2)
}
const observeAfterAction = process.env.OSWORLD_OBSERVE_AFTER_ACTION !== 'false'

/** Commands after which the screen is expected to change; the same rule as the pi harness. */
const actionCommand = /^(?:input|app|window\.(?:click|drag|scroll))\./u

const log = createWriteStream(tapFile, { flags: 'a' })
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })

/** The registry command a `tools/call` runs: compact `invoke` names it, typed tools spell it `input_clickPoint`. */
function commandOf(params) {
  if (params?.name === 'invoke') {
    return params.arguments?.command_id
  }
  return typeof params?.name === 'string' && params.name.includes('_') ? params.name.replace('_', '.') : undefined
}

function record(direction, message) {
  log.write(`${JSON.stringify({ direction, message: typeof message === 'string' ? message : redacted(message), time: Date.now() })}\n`)
}

function redacted(message) {
  return JSON.parse(JSON.stringify(message), (key, value) => key === 'data' && typeof value === 'string' && value.length > 256 ? `<${value.length} base64 chars>` : value)
}

// Tap-originated requests, answered by the server's responses with these ids.
const internal = new Map()
let internalId = 0

function callServer(name, toolArguments) {
  const id = `osworld-tap-${internalId++}`
  const message = { id, jsonrpc: '2.0', method: 'tools/call', params: { arguments: toolArguments, name } }
  record('tap_to_server', message)
  child.stdin.write(`${JSON.stringify(message)}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      internal.delete(id)
      reject(new Error(`${name} timed out`))
    }, 60_000)
    internal.set(id, (response) => {
      clearTimeout(timer)
      resolve(response)
    })
  })
}

/** Captures the display and returns MCP image content, or `[]` when any step fails. */
async function screenAfterAction() {
  const capture = await callServer('invoke', { command_id: 'display.capture', inputs: {} })
  const uri = capture.result?.structuredContent?.artifacts?.find(artifact => artifact.content_type?.startsWith('image/'))?.uri
  const match = /^auv:\/\/runs\/([^/]+)\/artifacts\/([^/]+)$/u.exec(uri ?? '')
  if (match == null) {
    return []
  }
  const image = await callServer('artifact_read_image', { artifact_id: match[2], run_id: match[1] })
  return (image.result?.content ?? []).filter(part => part.type === 'image')
}

// Client requests whose results get a screenshot, by request id.
const actions = new Set()

createInterface({ crlfDelay: Infinity, input: process.stdin }).on('line', (line) => {
  record('client_to_server', parse(line) ?? line)
  const message = parse(line)
  if (observeAfterAction && message?.method === 'tools/call' && actionCommand.test(commandOf(message.params) ?? '')) {
    actions.add(message.id)
  }
  child.stdin.write(`${line}\n`)
})

createInterface({ crlfDelay: Infinity, input: child.stdout }).on('line', (line) => {
  const message = parse(line)
  if (message != null && internal.has(message.id)) {
    record('server_to_tap', message)
    const resolve = internal.get(message.id)
    internal.delete(message.id)
    resolve(message)
    return
  }
  record('server_to_client', message ?? line)
  if (message == null || !actions.has(message.id)) {
    process.stdout.write(`${line}\n`)
    return
  }
  actions.delete(message.id)
  const failed = message.error != null || message.result?.isError === true || message.result?.structuredContent?.status === 'failed'
  if (failed) {
    process.stdout.write(`${line}\n`)
    return
  }
  screenAfterAction()
    .catch(() => [])
    .then((images) => {
      if (images.length > 0) {
        message.result.content = [...(message.result.content ?? []), { text: 'Screen after this action:', type: 'text' }, ...images]
      }
      record('observation', { attached: images.length, id: message.id })
      process.stdout.write(`${JSON.stringify(message)}\n`)
    })
})

function parse(line) {
  try {
    return JSON.parse(line)
  }
  catch {
    return undefined
  }
}

process.stdin.on('end', () => child.stdin.end())
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  log.end(() => process.exit(code ?? (signal == null ? 0 : 1)))
})
