import type { AgentResult, AgentStep, AgentTelemetry, Reply } from '../../agent'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { AgentRunError } from '../../agent'

/**
 * How to start the AUV MCP server for one episode. opencode spawns it
 * itself, so the harness passes a launch spec instead of an MCP client.
 */
export interface AuvMcpLaunch {
  args: string[]
  command: string
  /** Working directory; `auv` keeps its Run store in `<cwd>/.auv/store`. */
  cwd: string
  env: Record<string, string>
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))

/** Output text kept per step in `result.json`. */
const maxOutputText = 4_000

// NOTICE: opencode 2.2.2 sometimes stalls before its standalone server
// boots (no event for minutes), most often right after another run shut
// down. A run that prints no event within this budget is killed and
// retried with fresh state; retries are recorded, not hidden.
const startupTimeoutMs = Number(process.env.OSWORLD_OPENCODE_STARTUP_SECONDS ?? 120) * 1000
const startupAttempts = 3

// NOTICE: Same task guidance as `systemPrompt` in `src/agent.ts`, adapted to
// opencode: screenshots are not attached by the harness, the end tools live
// on the `osworld` MCP server, and Code Mode may batch calls in one script.
// Keep it identical across tool-exposure arms; it must not name AUV tools
// whose names differ between arms.
const systemPrompt = `You operate an Ubuntu GNOME desktop through AUV tools to complete the user's task.
Look at the screen before acting: capture it with AUV and read the returned image with artifact_read_image.
Screen coordinates are logical pixels; the display is 1920x1080 at scale 1.
When the task is complete, call the osworld done tool. If it cannot be done, call the osworld fail tool. Then stop.
Work in the application the task names, through its own windows, menus, and dialogs. Use a terminal only when the task is about the terminal, the shell, or system state that has no graphical setting; do not write scripts to edit documents, spreadsheets, images, or settings in place of the application.
Some tasks are impossible as asked, for example a feature the application does not have. Decide whether the task is feasible before working around it; if it is not, call fail instead of approximating it. Do not call fail only because a step is slow or tedious.
A completed AUV command means the input was delivered, not that it had the intended effect. Check the screen before you call done.
The user password is "password".`

interface McpCallResult {
  content?: Array<{ text?: string, type?: string }>
  isError?: boolean
  structuredContent?: { run_id?: string }
}

interface OpencodeEvent {
  error?: unknown
  part?: {
    id?: string
    state?: { input?: unknown }
    tokens?: { cache?: { read?: number, write?: number }, input?: number, output?: number, reasoning?: number }
    tool?: string
  }
  type?: string
}

interface TapLine {
  direction: 'client_to_server' | 'server_to_client'
  message: { error?: { message?: string }, id?: number | string, method?: string, params?: { arguments?: Record<string, unknown>, name?: string }, result?: McpCallResult }
}

/**
 * Runs one episode through opencode 2 (`opencode run`) with AUV as an MCP
 * server in Code Mode.
 *
 * Call stack:
 *
 * {@link runEpisode}
 *   -> {@link runAgent}
 *     -> `opencode run --standalone --agent osworld`
 *       -> `mcpTap.mjs` -> `auv --device-id <guest> mcp serve`
 *       -> `episodeTools.mjs` (`done` / `fail`)
 *   -> steps and run IDs from the tap log, usage from `step_finish` events
 *
 * opencode runs outside the repository with its own HOME and XDG
 * directories, so no AGENTS.md, skills, or user config reach the prompt.
 */
export async function runAgent(
  instruction: string,
  model: string,
  auv: AuvMcpLaunch,
  options: { evidenceDirectory: string, maxSteps: number, signal: AbortSignal, telemetry?: AgentTelemetry },
): Promise<AgentResult> {
  const binary = process.env.OSWORLD_OPENCODE_BINARY
  if (binary == null || binary === '') {
    throw new Error('OSWORLD_OPENCODE_BINARY must point at an opencode 2 executable.')
  }
  const root = await mkdtemp(join(tmpdir(), 'auv-osworld-opencode-'))
  const tapFile = join(options.evidenceDirectory, 'auv-mcp-tap.jsonl')
  const decisionFile = join(root, 'decision.json')
  const result: AgentResult = { modelRequests: 0, runIds: [], steps: [], usage: {} }
  const details = { errors: [] as string[], exitCode: undefined as number | undefined, startupRetries: 0, stopReason: undefined as string | undefined, toolUses: {} as Record<string, number> }
  try {
    const work = join(root, 'work')
    await mkdir(work, { recursive: true })
    await mkdir(auv.cwd, { recursive: true })
    const config = opencodeConfig(model, options.maxSteps, auv, tapFile, decisionFile)
    await writeFile(join(work, 'opencode.jsonc'), `${JSON.stringify(config, null, 2)}\n`)
    await copyFile(join(work, 'opencode.jsonc'), join(options.evidenceDirectory, 'opencode.jsonc'))

    for (let attempt = 1; ; attempt += 1) {
      const outcome = await runOnce(binary, root, work, instruction, model, attempt, result, details, options)
      if (outcome === 'started') {
        break
      }
      if (attempt >= startupAttempts) {
        throw new Error(`opencode printed no event within ${String(startupTimeoutMs / 1000)} s in ${String(startupAttempts)} attempts.`)
      }
      details.startupRetries += 1
    }

    const tapped = await tappedCalls(tapFile)
    result.steps = tapped.steps
    result.runIds = tapped.runIds
    result.lastAction = await readFile(decisionFile, 'utf8').then(text => (JSON.parse(text) as { action: 'DONE' | 'FAIL' }).action, () => undefined)
    // NOTICE: At the step limit opencode sends one closing request with
    // `tool_choice: "none"`, which OpenCode Go's Muse Spark rejects with 400
    // ("only auto is supported"). That is an exhausted step budget, as
    // reaching OSWORLD_MAX_STEPS is for the other harnesses, not an error.
    if (details.exitCode !== 0 && (result.modelRequests ?? 0) >= options.maxSteps - 1 && details.errors.some(error => error.includes('tool_choice'))) {
      details.stopReason = 'step_budget'
    }
    else if (details.exitCode !== 0) {
      throw new Error(`opencode exited with ${String(details.exitCode)}; see opencode.stderr.log.`)
    }
    return { ...result, harness: details }
  }
  catch (error) {
    throw new AgentRunError({ ...result, harness: details }, error)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

/** opencode 2.2.2 built-in tools; only `execute` (Code Mode) stays allowed. */
const builtinTools = ['shell', 'bash', 'edit', 'write', 'patch', 'read', 'list', 'glob', 'grep', 'lsp', 'webfetch', 'websearch', 'task', 'todowrite', 'todoread', 'skill', 'question']

function opencodeConfig(model: string, maxSteps: number, auv: AuvMcpLaunch, tapFile: string, decisionFile: string): Record<string, unknown> {
  return {
    agents: {
      osworld: {
        description: 'Operates the OSWorld desktop through AUV.',
        mode: 'primary',
        model,
        // NOTICE: The agent acts only through MCP tools. Shell, file, and web
        // tools would bypass AUV, as `pyautogui` would in upstream OSWorld.
        // The 2026-10-30 smoke still reached `glob` and `grep`, so every built-in
        // tool except Code Mode's `execute` is denied.
        permissions: builtinTools.map(action => ({ action, effect: 'deny', resource: '*' })),
        steps: maxSteps,
        system: systemPrompt,
      },
    },
    mcp: {
      servers: {
        auv: {
          codemode: true,
          command: [process.execPath, join(scriptDirectory, 'mcpTap.mjs'), auv.command, ...auv.args],
          cwd: auv.cwd,
          environment: { ...auv.env, OSWORLD_MCP_TAP_FILE: tapFile },
          type: 'local',
        },
        osworld: {
          codemode: true,
          command: [process.execPath, join(scriptDirectory, 'episodeTools.mjs')],
          environment: { OSWORLD_EPISODE_DECISION_FILE: decisionFile },
          type: 'local',
        },
      },
    },
  }
}

/** One `opencode run`; `stalled` when it printed no event before {@link startupTimeoutMs}. */
async function runOnce(
  binary: string,
  root: string,
  work: string,
  message: string,
  model: string,
  attempt: number,
  result: AgentResult,
  details: { errors: string[], exitCode: number | undefined, toolUses: Record<string, number> },
  options: { evidenceDirectory: string, signal: AbortSignal, telemetry?: AgentTelemetry },
): Promise<'stalled' | 'started'> {
  const state = join(root, `state-${String(attempt)}`)
  for (const directory of ['home', 'config', 'data', 'state']) {
    await mkdir(join(state, directory), { recursive: true })
  }
  // NOTICE: opencode resolves its project from `PWD`, not the process cwd.
  // An inherited `PWD` (the eval package) loaded that project's config and
  // AGENTS.md instead of the episode's, and `--agent osworld` was not found.
  const env = {
    ...process.env,
    HOME: join(state, 'home'),
    INIT_CWD: work,
    PWD: work,
    XDG_CACHE_HOME: process.env.OSWORLD_OPENCODE_CACHE_HOME ?? join(state, 'cache'),
    XDG_CONFIG_HOME: join(state, 'config'),
    XDG_DATA_HOME: join(state, 'data'),
    XDG_STATE_HOME: join(state, 'state'),
  }
  const child = spawn(binary, ['run', '--standalone', '--auto', '--format', 'json', '--agent', 'osworld', '-m', model, message], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const events = createWriteStream(join(options.evidenceDirectory, `opencode-events-${String(attempt)}.jsonl`))
  const stderr = createWriteStream(join(options.evidenceDirectory, `opencode-${String(attempt)}.stderr.log`))
  child.stderr.pipe(stderr)
  const abort = (): void => {
    child.kill('SIGTERM')
  }
  options.signal.addEventListener('abort', abort, { once: true })

  let started = false
  let stepStartedAt = 0
  let calls: Reply['calls'] = []
  const stall = setTimeout(() => {
    if (!started) {
      child.kill('SIGKILL')
    }
  }, startupTimeoutMs)
  createInterface({ crlfDelay: Infinity, input: child.stdout }).on('line', (line) => {
    events.write(`${line}\n`)
    started = true
    let event: OpencodeEvent
    try {
      event = JSON.parse(line) as OpencodeEvent
    }
    catch {
      return
    }
    if (event.type === 'step_start') {
      stepStartedAt = performance.now()
      calls = []
      options.telemetry?.requested(result.modelRequests ?? 0)
    }
    else if (event.type === 'tool_use') {
      const tool = event.part?.tool ?? 'unknown'
      details.toolUses[tool] = (details.toolUses[tool] ?? 0) + 1
      calls.push({ arguments: JSON.stringify(event.part?.state?.input ?? {}), callId: event.part?.id ?? '', name: tool })
    }
    else if (event.type === 'error') {
      details.errors.push(JSON.stringify(event.error ?? {}).slice(0, 500))
    }
    else if (event.type === 'step_finish') {
      result.modelRequests = (result.modelRequests ?? 0) + 1
      const usage = usageOf(event.part?.tokens)
      for (const [key, value] of Object.entries(usage)) {
        result.usage![key] = (result.usage![key] ?? 0) + value
      }
      options.telemetry?.responded({ calls, text: '', usage }, performance.now() - stepStartedAt)
    }
  })
  const exitCode = await new Promise<null | number>((resolve) => {
    child.on('close', code => resolve(code))
  })
  clearTimeout(stall)
  options.signal.removeEventListener('abort', abort)
  events.end()
  stderr.end()
  if (!started && !options.signal.aborted) {
    return 'stalled'
  }
  details.exitCode = exitCode ?? -1
  return 'started'
}

/**
 * Pairs every AUV `tools/call` with its response. Typed per-command tools
 * (`window_list`) are folded back into the `invoke` argument shape so
 * `terminalUseOf` reads both exposures the same way.
 */
async function tappedCalls(tapFile: string): Promise<{ runIds: string[], steps: AgentStep[] }> {
  const text = await readFile(tapFile, 'utf8').catch(() => '')
  const requests = new Map<number | string, NonNullable<TapLine['message']['params']>>()
  const steps: AgentStep[] = []
  const runIds: string[] = []
  for (const line of text.split('\n').filter(Boolean)) {
    const { direction, message } = JSON.parse(line) as TapLine
    if (direction === 'client_to_server' && message.method === 'tools/call' && message.id != null) {
      requests.set(message.id, message.params ?? {})
      continue
    }
    if (direction !== 'server_to_client' || message.id == null || !requests.has(message.id)) {
      continue
    }
    const params = requests.get(message.id)!
    requests.delete(message.id)
    const runId = message.result?.structuredContent?.run_id
    if (runId != null) {
      runIds.push(runId)
    }
    const output = message.error != null
      ? `MCP error: ${message.error.message ?? ''}`
      : message.result?.structuredContent != null
        ? JSON.stringify(message.result.structuredContent)
        : (message.result?.content ?? []).map(part => part.text ?? `<${part.type ?? 'content'}>`).join('\n')
    steps.push({
      arguments: JSON.stringify(invokeShaped(params.name ?? '', params.arguments ?? {})),
      output: output.length > maxOutputText ? `${output.slice(0, maxOutputText)}…[truncated]` : output,
      runId,
      tool: params.name,
    })
  }
  return { runIds, steps }
}

/** Maps opencode step tokens (input excludes cache) onto the Responses field names earlier runs recorded. */
function usageOf(tokens: NonNullable<OpencodeEvent['part']>['tokens']): Record<string, number> {
  if (tokens == null) {
    return {}
  }
  const input = tokens.input ?? 0
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  return {
    'input_tokens': input + cacheRead + cacheWrite,
    'input_tokens_details.cache_write_tokens': cacheWrite,
    'input_tokens_details.cached_tokens': cacheRead,
    'output_tokens': output,
    'output_tokens_details.reasoning_tokens': reasoning,
    'total_tokens': input + cacheRead + cacheWrite + output + reasoning,
  }
}

const nonCommandTools = new Set(['artifact_read_image', 'device_ensure_user_session_locked', 'device_ensure_user_session_unlocked', 'device_get_user_session', 'device_list_user_sessions', 'invoke', 'op_run'])

function invokeShaped(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (nonCommandTools.has(name)) {
    return args
  }
  const { device_id: _deviceId, device_name: _deviceName, target, ...inputs } = args
  return { command_id: name.replace('_', '.'), inputs, target }
}
