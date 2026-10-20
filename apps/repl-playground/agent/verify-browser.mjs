import assert from 'node:assert/strict'
import process from 'node:process'

import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { WebSocketServer } from 'ws'

import { startProxy } from './proxy.mjs'

/** Exercise the actual connection UI with synthetic Exterior responses and ACP frames. */
async function verifyAgentConnection(browser, url) {
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const messages = []
  let supported = true
  let connections = 0
  server.on('connection', (socket) => {
    connections++
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      messages.push(message)
      let result
      if (message.method === 'initialize') {
        result = { agentCapabilities: supported ? { _meta: { auv: { codemode: 1 } } } : {}, protocolVersion: 1 }
      }
      else if (message.method === 'session/new') {
        result = { sessionId: `ui-${message.id}` }
      }
      else if (message.method === 'session/prompt') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: message.params.sessionId,
          update: { content: { text: 'Connected through the test ACP peer.', type: 'text' }, sessionUpdate: 'agent_message_chunk' },
        } }))
        result = { stopReason: 'end_turn' }
      }
      if (result)
        socket.send(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }))
    })
  })
  try {
    // Supply an unexpired synthetic account through the upstream storage
    // contract. This test does not exercise OAuth or contact a live relay.
    await page.addInitScript(() => {
      sessionStorage.setItem('exterior.clientId:http://127.0.0.1:8787', 'browser-check')
      sessionStorage.setItem('exterior.accessToken', 'synthetic-token')
      sessionStorage.setItem('exterior.expiresAt', String(Date.now() + 3600000))
    })
    const cwd = 'C:/Users/test/agent-workspace'
    await page.route('http://127.0.0.1:8787/api/devices', route => route.fulfill({ json: { devices: [
      { agents: [{ agentType: 'custom', name: 'auv' }], hostname: 'agent-device', id: 'device', platform: 'windows', workingDirectory: cwd },
    ] } }))
    await page.route('http://127.0.0.1:8787/api/connections', (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204 })
      assert.deepEqual(route.request().postDataJSON(), { agentName: 'auv', deviceId: 'device' })
      assert.equal(route.request().headers().authorization, 'Bearer synthetic-token')
      return route.fulfill({ json: { agentName: 'auv', agentType: 'custom', url: `ws://127.0.0.1:${server.address().port}` } })
    })
    await page.goto(url)
    await page.getByRole('button', { exact: true, name: 'Connect' }).click()
    await page.getByRole('textbox', { name: 'Message the agent' }).waitFor()
    assert.ok(messages.some(message => message.method === 'session/new' && message.params.cwd === cwd), 'ACP must use the selected device directory')
    const opened = connections
    const sessions = messages.filter(message => message.method === 'session/new').length
    await page.getByRole('tab', { exact: true, name: 'Script' }).click()
    await page.getByRole('tab', { exact: true, name: 'Agent' }).click()
    await page.getByRole('textbox', { name: 'Message the agent' }).fill('Check the connection')
    await page.getByRole('button', { exact: true, name: 'Send' }).click()
    await page.getByText('Connected through the test ACP peer.', { exact: true }).waitFor()
    assert.equal(connections, opened, 'Tab switches must retain the ACP socket')
    assert.equal(messages.filter(message => message.method === 'session/new').length, sessions, 'Tab switches must retain the ACP session')
    assert.ok(messages.find(message => message.method === 'session/prompt').params.prompt.some(part => part.text?.includes('api.help()')))
    if (process.env.AUV_AGENT_CONNECTED_SCREENSHOT)
      await page.screenshot({ animations: 'disabled', path: process.env.AUV_AGENT_CONNECTED_SCREENSHOT })
    await page.getByRole('button', { exact: true, name: 'Start a new agent session' }).click()
    await page.getByText('Connected through the test ACP peer.', { exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('textbox', { name: 'Message the agent' }).fill('Check the new session')
    await page.getByRole('button', { exact: true, name: 'Send' }).click()
    await page.getByText('Connected through the test ACP peer.', { exact: true }).waitFor()
    const prompts = messages.filter(message => message.method === 'session/prompt')
    assert.equal(prompts.length, 2)
    assert.notEqual(prompts[0].params.sessionId, prompts[1].params.sessionId)
    assert.ok(prompts[1].params.prompt.some(part => part.text?.includes('api.help()')), 'New sessions must receive the briefing again')
    await page.getByRole('button', { exact: true, name: 'Disconnect' }).click()
    supported = false
    const newSessions = messages.filter(message => message.method === 'session/new').length
    await page.getByRole('button', { exact: true, name: 'Connect' }).click()
    await page.getByText('This connection does not provide code execution.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Message the agent' }).count(), 0)
    assert.equal(messages.filter(message => message.method === 'session/new').length, newSessions)
    assert.deepEqual(errors, [])
    return { connectionPreserved: true, deviceDirectory: true, newSessionBriefing: true, unsupportedAgentBlocked: true }
  }
  finally {
    await page.close()
    for (const socket of server.clients)
      socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}

/** Exercise the real browser worker and SDK with a fake ACP peer and real MCP client. */
async function verifyBrowser() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const vite = await createServer({ configFile: `${root}/vite.config.ts`, define: { 'import.meta.env.VITE_EXTERIOR_URL': JSON.stringify('http://127.0.0.1:8787') }, root, server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const webSocket = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => webSocket.once('listening', resolve))
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined), headless: true })
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const input = new PassThrough()
  const output = new PassThrough()
  const proxy = await startProxy({ args: [fileURLToPath(new URL('./fake-agent.fixture.mjs', import.meta.url))], command: process.execPath, input, output })
  webSocket.on('connection', (socket) => {
    socket.on('message', data => input.write(`${data.toString()}\n`))
    createInterface({ input: output }).on('line', line => socket.send(line))
  })
  const client = new Client({ name: 'browser-check', version: '1' })
  try {
    await page.goto(vite.resolvedUrls.local[0])
    const agentTab = page.getByRole('tab', { exact: true, name: 'Agent' })
    const scriptTab = page.getByRole('tab', { exact: true, name: 'Script' })
    await agentTab.waitFor()
    await page.getByRole('button', { name: 'Sign in with Exterior' }).waitFor()
    const agentPanel = await page.getByRole('tabpanel', { name: 'Agent' }).elementHandle()
    const editor = await page.locator('.cm-editor').elementHandle()
    await scriptTab.click()
    assert.equal(await scriptTab.getAttribute('aria-selected'), 'true')
    assert.equal(await agentTab.getAttribute('aria-selected'), 'false')
    assert.equal(await agentPanel.isVisible(), false)
    assert.equal(await editor.isVisible(), true)
    await agentTab.click()
    assert.equal(await agentTab.getAttribute('aria-selected'), 'true')
    assert.equal(await agentPanel.isVisible(), true)
    assert.equal(await editor.isVisible(), false)
    assert.equal(await agentPanel.evaluate(node => node.isConnected), true)
    assert.equal(await editor.evaluate(node => node.isConnected), true)
    await page.evaluate(async () => {
      await (await import('/playground/src/features/device/devices.ts')).restoreDevices()
      window.playgroundState = (await import('/playground/src/store.ts')).usePlayground.getState
      const { session } = await import('/playground/src/runtime/session.ts')
      const outcome = await session.run({ mode: 'run', source: 'const editorValue = 99;', startLine: 1 })
      if (outcome.status !== 'ok')
        throw new Error('Editor REPL setup failed')
    })
    const server = await page.evaluate(async (url) => {
      const { CodeModeHost, codeModeStream } = await import('/playground/src/features/agent/codemode-bridge.ts')
      const socket = new WebSocket(url)
      await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
      const raw = {
        readable: new ReadableStream({ start(controller) { socket.addEventListener('message', event => controller.enqueue(JSON.parse(event.data))) } }),
        writable: new WritableStream({ write(message) { socket.send(JSON.stringify(message)) } }),
      }
      const host = new CodeModeHost()
      const stream = codeModeStream(raw, host, new AbortController().signal, (supported) => {
        window.codemodeSupported = supported
      })
      const reader = stream.readable.getReader()
      const writer = stream.writable.getWriter()
      await writer.write({ id: 1, jsonrpc: '2.0', method: 'initialize', params: { clientCapabilities: { _meta: { auv: { codemode: 1 } } }, protocolVersion: 1 } })
      await reader.read()
      await writer.write({ id: 2, jsonrpc: '2.0', method: 'session/new', params: { cwd: '/', mcpServers: [] } })
      const message = (await reader.read()).value
      host.setSession(message.result.sessionId)
      window.codemodeHost = host
      void (async () => {
        while (!(await reader.read()).done) {
          // Consume ordinary ACP traffic while the stream handles tool calls.
        }
      })()
      return message.result._meta.receivedServers[0]
    }, `ws://127.0.0.1:${webSocket.address().port}`)
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }))
    assert.match((await client.listTools()).tools[0].description, /api\.help/)
    const discovery = await client.callTool({ arguments: { code: 'text(api.help()); text(api.describe({ path: api.search({ query: "WindowClient.findText" }).items[0].path }));' }, name: 'codemode' })
    assert.equal(discovery.isError, false, JSON.stringify(discovery))
    const help = JSON.parse(discovery.content[1].text)
    assert.match(help.signature, /query: string/)
    assert.match(help.types.FindWindowTextResponse.definition, /matches/)
    assert.equal((await page.evaluate(() => window.playgroundState().calls)).length, 0, 'Metadata help must not call the device')
    const example = await client.callTool({ arguments: { code: help.examples[0] }, name: 'codemode' })
    assert.equal(example.isError, false, JSON.stringify(example))
    assert.ok(example.content.some(item => item.type === 'text' && item.text.includes('Increment')))
    const result = await client.callTool({ arguments: { code: `
      const counter = await auv.windows.resolve({ appName: 'Counter' });
      const found = await counter.findText('Increment');
      if (found.matches.length !== 1) throw new Error('Expected one button');
      for (let i = 0; i < 3; i++) await counter.click(found.matches[0]);
      const after = await counter.findText('3');
      text(after.matches.map(item => item.text));
      store('counterId', counter.id);
      const shot = await counter.capture();
      await image(shot.capture);
    ` }, name: 'codemode' })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.ok(result.content.some(item => item.type === 'image'))
    assert.ok(result.content.some(item => item.type === 'text' && item.text === '["Count: 3"]'))
    const calls = await page.evaluate(async () => (await import('/playground/src/store.ts')).usePlayground.getState().calls.map(call => ({ effect: call.effect, method: call.method, status: call.status })))
    assert.equal(calls.filter(call => call.effect === 'input').length, 3)
    assert.ok(calls.every(call => call.status === 'ok'))
    await scriptTab.click()
    await page.locator('.cm-content').filter({ hasText: 'Count' }).waitFor()
    if (process.env.AUV_CODEMODE_SCREENSHOT)
      await page.screenshot({ animations: 'disabled', path: process.env.AUV_CODEMODE_SCREENSHOT })
    await page.setViewportSize({ height: 768, width: 1024 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The workbench must fit the viewport')
    await agentTab.click()
    assert.equal(await agentPanel.evaluate(node => node.isConnected), true)
    assert.equal(await editor.evaluate(node => node.isConnected), true)
    if (process.env.AUV_AGENT_SCREENSHOT)
      await page.screenshot({ animations: 'disabled', path: process.env.AUV_AGENT_SCREENSHOT })
    const saved = await client.callTool({ arguments: { code: 'text(load("counterId")); text(typeof counter); text(typeof editorValue);' }, name: 'codemode' })
    assert.equal(saved.isError, false)
    assert.equal(saved.content.filter(item => item.type === 'text' && item.text === 'undefined').length, 2)
    const failed = await client.callTool({ arguments: { code: 'store("counterId", "bad"); text("before"); throw new Error("intentional");' }, name: 'codemode' })
    assert.equal(failed.isError, true)
    assert.ok(failed.content.some(item => item.type === 'text' && item.text === 'before'))
    const restored = await client.callTool({ arguments: { code: 'return load("counterId");' }, name: 'codemode' })
    assert.ok(restored.content.some(item => item.type === 'text' && item.text === 'w-counter'))
    const jpeg = await client.callTool({ arguments: { code: `
      const counter = await auv.windows.get(load('counterId'));
      await image((await counter.capture()).capture, { encoding: sdk.ImageEncoding.JPEG, maxSize: { height: 256, width: 256 } });
    ` }, name: 'codemode' })
    assert.equal(jpeg.isError, false, JSON.stringify(jpeg))
    assert.ok(jpeg.content.some(item => item.type === 'image' && item.mimeType === 'image/jpeg'))
    const canceled = client.callTool({ arguments: { code: 'text("waiting"); await new Promise(() => {});', timeoutMs: 10000 }, name: 'codemode' })
    await page.waitForFunction(() => window.playgroundState().logs.some(log => log.values.includes('waiting')))
    await page.evaluate(() => window.codemodeHost.cancel())
    const canceledResult = await canceled
    assert.equal(canceledResult.isError, true)
    assert.ok(canceledResult.content.some(item => item.type === 'text' && item.text === 'waiting'), JSON.stringify(canceledResult))
    const loop = await client.callTool({ arguments: { code: 'while (true) {}', timeoutMs: 300 }, name: 'codemode' })
    assert.equal(loop.isError, true)
    const recovered = await client.callTool({ arguments: { code: 'return 7;' }, name: 'codemode' })
    assert.equal(recovered.isError, false)
    const editorRun = await page.evaluate(async () => (await import('/playground/src/runtime/session.ts')).session.run({ mode: 'run', source: 'editorValue;', startLine: 1 }))
    assert.equal(editorRun.value, 99)
    assert.equal(errors.length, 0, errors.join('\n'))
    const agentUi = await verifyAgentConnection(browser, vite.resolvedUrls.local[0])
    console.info(JSON.stringify({ agentUi, calls, cancellation: true, discoveryAndHelpExample: true, editorStatePreserved: true, images: true, mountedTabsPreserved: true, stateRollback: true, timeoutAndRecovery: true, viewportFit: true }, null, 2))
  }
  finally {
    await client.close()
    proxy.close()
    webSocket.close()
    await browser.close()
    await vite.close()
  }
}

void verifyBrowser().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
