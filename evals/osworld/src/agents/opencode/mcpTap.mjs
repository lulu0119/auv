import process from 'node:process'

// Transparent stdio tap between an MCP client and one MCP server.
//
// Usage: node mcpTap.mjs <server command> [args...]
//
// Forwards every JSON-RPC line unchanged in both directions and appends each
// one, with its direction and time, to `OSWORLD_MCP_TAP_FILE`. The opencode
// harness reads the log to recover the exact AUV calls a model made, which
// Code Mode hides inside `execute` scripts.
//
// NOTICE: Image `data` fields are replaced by their length in the log only;
// forwarded bytes are never changed. One capture is megabytes of base64.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createInterface } from 'node:readline'

const [command, ...args] = process.argv.slice(2)
const tapFile = process.env.OSWORLD_MCP_TAP_FILE
if (command == null || tapFile == null) {
  process.stderr.write('Usage: OSWORLD_MCP_TAP_FILE=<log> node mcpTap.mjs <command> [args...]\n')
  process.exit(2)
}

const log = createWriteStream(tapFile, { flags: 'a' })
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })

function redacted(line) {
  try {
    return JSON.parse(line, (key, value) => key === 'data' && typeof value === 'string' && value.length > 256 ? `<${value.length} base64 chars>` : value)
  }
  catch {
    return line
  }
}

function tap(input, output, direction) {
  createInterface({ crlfDelay: Infinity, input }).on('line', (line) => {
    output.write(`${line}\n`)
    log.write(`${JSON.stringify({ direction, message: redacted(line), time: Date.now() })}\n`)
  })
}

tap(process.stdin, child.stdin, 'client_to_server')
tap(child.stdout, process.stdout, 'server_to_client')
process.stdin.on('end', () => child.stdin.end())
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  log.end(() => process.exit(code ?? (signal == null ? 0 : 1)))
})
