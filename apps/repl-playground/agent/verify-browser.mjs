import assert from 'node:assert/strict'
import process from 'node:process'

import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { WebSocketServer } from 'ws'

import { createMcpRelay } from './relay.fixture.mjs'

/** Exercise the actual connection UI with synthetic Exterior responses and ACP frames. */
async function verifyAgentConnection(browser, url, relay, imageResult) {
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const messages = []
  let supported = true
  let connections = 0
  const clients = []
  server.on('connection', (socket) => {
    connections++
    socket.on('message', async (data) => {
      const message = JSON.parse(data.toString())
      messages.push(message)
      let result
      if (message.method === 'initialize') {
        result = { agentCapabilities: supported ? { mcpCapabilities: { http: true } } : {}, protocolVersion: 1 }
      }
      else if (message.method === 'session/new') {
        const declaration = message.params.mcpServers.find(server => server.type === 'http')
        assert.ok(declaration, 'An ordinary agent must receive the HTTP MCP declaration')
        const client = new Client({ name: 'agent', version: '1' })
        await client.connect(new StreamableHTTPClientTransport(new URL(declaration.url), { requestInit: { headers: Object.fromEntries(declaration.headers.map(header => [header.name, header.value])) } }))
        assert.equal((await client.listTools()).tools[0].name, 'codemode', 'Tool discovery must work before ACP session creation finishes')
        clients.push(client)
        result = { sessionId: `ui-${message.id}` }
      }
      else if (message.method === 'session/prompt') {
        const notify = update => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update } }))
        // ROOT CAUSE: the chat rendered only the wrapper's completed status,
        // hiding its input and the failed nested tool result delivered by ACP.
        // OpenCode 2.0.26 sends nested statuses in rawOutput.metadata.toolCalls.
        notify({ content: { text: 'I will inspect the desktop and check the result.', type: 'text' }, sessionUpdate: 'agent_message_chunk' })
        notify({ content: [{ content: { text: 'ReferenceError: Unknown identifier \'text\'.', type: 'text' }, type: 'content' }], kind: 'other', rawInput: { code: 'text(api.help());' }, rawOutput: { metadata: { error: true } }, sessionUpdate: 'tool_call', status: 'completed', title: 'execute', toolCallId: 'code-failure' })
        notify({ kind: 'other', rawInput: { code: 'return await tools["auv-playground"].codemode({ code: "await auv.overlay.show({});" });' }, sessionUpdate: 'tool_call', status: 'in_progress', title: 'execute', toolCallId: 'nested-failure' })
        notify({ content: [{ content: { text: 'Script failed: OverlayService/ShowOverlay is UNIMPLEMENTED', type: 'text' }, type: 'content' }], rawOutput: { metadata: { toolCalls: [{ status: 'error', tool: 'auv-playground.codemode' }] } }, sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'nested-failure' })
        notify({ content: [{ content: imageResult, type: 'content' }], kind: 'read', rawInput: { code: 'await image(capture);' }, sessionUpdate: 'tool_call', status: 'completed', title: 'Capture result', toolCallId: 'image-result' })
        notify({ content: [{ content: { text: '0 errors found.', type: 'text' }, type: 'content' }], kind: 'read', rawInput: { path: 'notes.md' }, sessionUpdate: 'tool_call', status: 'completed', title: 'Read notes', toolCallId: 'neutral-result' })
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: message.params.sessionId,
          update: { content: { text: 'Connected through the test ACP peer.', type: 'text' }, sessionUpdate: 'agent_message_chunk' },
        } }))
        result = { stopReason: 'end_turn' }
      }
      if (result) {
        socket.send(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }))
      }
    })
  })
  try {
    // Supply an unexpired synthetic account through the upstream storage
    // contract. This test does not exercise OAuth or contact a live relay.
    await page.addInitScript(() => {
      sessionStorage.setItem('exterior.accessToken', 'synthetic-token')
      sessionStorage.setItem('exterior.expiresAt', String(Date.now() + 3600000))
    })
    const cwd = 'C:/Users/test/agent-workspace'
    await page.route(`${relay.url}/eap/v1/devices`, route => route.fulfill({ json: { devices: [
      { agents: [{ agentType: 'custom', name: 'auv' }], hostname: 'agent-device', id: 'device', platform: 'windows', workingDirectory: cwd },
    ] } }))
    await page.route(`${relay.url}/eap/v1/connections`, (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204 })
      assert.deepEqual(route.request().postDataJSON(), { agentName: 'auv', deviceId: 'device' })
      assert.equal(route.request().headers().authorization, 'Bearer connection-token')
      return route.fulfill({ json: { agentName: 'auv', agentType: 'custom', url: `ws://127.0.0.1:${server.address().port}` } })
    })
    await page.goto(url)
    await page.getByRole('button', { exact: true, name: 'Connect' }).waitFor({ state: 'visible' })
    // A token can rotate after discovery. Each connection needs a live token,
    // rather than the one the account held when the form mounted.
    await page.evaluate(() => sessionStorage.setItem('exterior.accessToken', 'connection-token'))
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
    const activity = page.locator('[data-agent-activity]')
    await activity.locator('summary').first().waitFor()
    assert.match(await activity.locator('summary').first().textContent(), /4 activities/, 'Adjacent tool calls must share a compact activity summary')
    assert.match(await activity.locator('summary').first().textContent(), /2 issues/, 'Returned errors must remain visible when the activity is collapsed')
    await activity.locator('.agent-activity-errors').getByText('Script failed: OverlayService/ShowOverlay is UNIMPLEMENTED', { exact: true }).waitFor()
    const image = activity.getByRole('img', { exact: true, name: 'Screenshot 1' })
    await image.scrollIntoViewIfNeeded()
    await image.evaluate(element => element.decode())
    assert.equal(await image.evaluate(element => element.complete && element.naturalWidth > 0), true, 'ACP tool images must render as images')
    await activity.getByRole('button', { exact: true, name: 'View screenshot 1' }).click()
    await page.getByRole('dialog', { exact: true, name: 'Screenshot 1' }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await activity.locator('summary').first().click()
    const tool = activity.locator('[data-tool-id="nested-failure"]')
    assert.equal(await tool.getAttribute('data-tool-status'), 'error')
    assert.equal(await activity.locator('[data-tool-id="code-failure"]').getAttribute('data-tool-status'), 'error')
    assert.equal(await activity.locator('[data-tool-id="neutral-result"]').getAttribute('data-tool-status'), 'finished', 'Result text must not be parsed to infer an error')
    await tool.locator('summary').first().click()
    await tool.locator('summary').filter({ hasText: 'Script' }).click()
    assert.equal(await tool.locator('[data-tool-script]').textContent(), 'return await tools["auv-playground"].codemode({ code: "await auv.overlay.show({});" });', 'Scripts must remain inspectable without JSON string escaping')
    await tool.locator('summary').filter({ hasText: 'Protocol details' }).click()
    await tool.getByText('ACP status: completed', { exact: true }).waitFor()
    assert.match(await tool.textContent(), /"status": "error"/, 'The original nested error metadata must remain inspectable')
    assert.ok(clients.length > 0, 'The agent must discover the browser tool through HTTP MCP')
    assert.ok(relay.registrations.includes('Bearer connection-token'), 'The MCP endpoint must use a live account token')
    assert.equal(connections, opened, 'Tab switches must retain the ACP socket')
    assert.equal(messages.filter(message => message.method === 'session/new').length, sessions, 'Tab switches must retain the ACP session')
    assert.ok(messages.find(message => message.method === 'session/prompt').params.prompt.some(part => part.text?.includes('api.help()')))
    if (process.env.AUV_AGENT_CONNECTED_SCREENSHOT) {
      await activity.locator('summary').first().click()
      await activity.locator('summary').first().scrollIntoViewIfNeeded()
      await page.screenshot({ animations: 'disabled', path: process.env.AUV_AGENT_CONNECTED_SCREENSHOT })
    }
    await page.setViewportSize({ height: 720, width: 1280 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Agent activity must fit the workbench at 1280 by 720')
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
    await page.getByText('This agent does not support HTTP MCP.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Message the agent' }).count(), 0)
    assert.equal(messages.filter(message => message.method === 'session/new').length, newSessions)
    assert.deepEqual(errors, [])
    return { connectionPreserved: true, deviceDirectory: true, inspectableToolResults: true, liveAccessToken: true, newSessionBriefing: true, unsupportedAgentBlocked: true }
  }
  catch (error) {
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- Only rendered text belongs in failure logs; closed protocol details can contain image data.
    console.error('Agent UI state:', await page.locator('body').innerText())
    console.error('ACP methods:', messages.map(message => message.method ?? 'response'))
    throw error
  }
  finally {
    await page.close()
    for (const client of clients)
      await client.close()
    for (const socket of server.clients)
      socket.terminate()
    await new Promise(resolve => server.close(resolve))
  }
}

/** Exercise the real browser worker through Exterior's MCP socket and standard HTTP MCP. */
async function verifyBrowser() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const relay = await createMcpRelay()
  const vite = await createServer({ cacheDir: 'node_modules/.vite-browser-check', configFile: `${root}/vite.config.ts`, define: { 'import.meta.env.VITE_EXTERIOR_URL': JSON.stringify(relay.url) }, root, server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined), headless: true })
  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
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
    await editor.waitForElementState('visible')
    await agentPanel.waitForElementState('hidden')
    assert.equal(await scriptTab.getAttribute('aria-selected'), 'true')
    assert.equal(await agentTab.getAttribute('aria-selected'), 'false')
    assert.equal(await agentPanel.isVisible(), false)
    assert.equal(await editor.isVisible(), true)
    await agentTab.click()
    await agentPanel.waitForElementState('visible')
    await editor.waitForElementState('hidden')
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
      const { CodeModeHost } = await import('/playground/src/features/agent/codemode-bridge.ts')
      const { serveMcp } = await import('/playground/src/features/agent/exterior.ts')
      const host = new CodeModeHost()
      const endpoint = await serveMcp(url, 'browser-check', transport => void host.connect(transport))
      host.setSession('browser-check')
      window.codemodeHost = host
      window.codemodeEndpoint = endpoint
      return { headers: endpoint.headers, url: endpoint.url }
    }, relay.url)
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }))
    await page.evaluate(() => {
      window.savedBackend = window.playgroundState().backend
      return import('/playground/src/store.ts').then(({ usePlayground }) => usePlayground.setState({ backend: null }))
    })
    try {
      const pure = await client.callTool({ arguments: { code: 'text(api.help().limits.memoryMiB); return 2;' }, name: 'codemode' })
      assert.equal(pure.isError, false, `Pure code and API help must work before a device is ready: ${JSON.stringify(pure)}`)
      const missing = await client.callTool({ arguments: { code: 'await auv.windows.list();' }, name: 'codemode' })
      assert.equal(missing.isError, true)
      assert.match(missing.content.at(-1).text, /needs a device/)
    }
    finally {
      await page.evaluate(async () => (await import('/playground/src/store.ts')).usePlayground.setState({ backend: window.savedBackend }))
    }
    assert.match((await client.listTools()).tools[0].description, /api\.help/)
    const discovery = await client.callTool({ arguments: { code: 'text(api.help()); text(api.describe({ path: api.search({ query: "WindowClient.findText" }).items[0].path }));' }, name: 'codemode' })
    assert.equal(discovery.isError, false, JSON.stringify(discovery))
    const help = JSON.parse(discovery.content[1].text)
    assert.match(help.signature, /query: string/)
    assert.match(help.types.FindWindowTextResponse.definition, /matches/)
    assert.equal((await page.evaluate(() => window.playgroundState().calls)).length, 0, 'Metadata help must not call the device')
    const selectedDisplay = await client.callTool({ arguments: { code: 'const selector = { selector: { case: "display", value: { displayId: "2" } } }; text((await auv.displays.capture(selector)).display.displayId); text((await auv.displays.findText(selector, "Counter")).matches.length);' }, name: 'codemode' })
    assert.equal(selectedDisplay.isError, false, JSON.stringify(selectedDisplay))
    assert.ok(selectedDisplay.content.some(item => item.text === '2'), 'The SDK selector must reach display 2')
    assert.ok(selectedDisplay.content.some(item => item.text === '1'), 'Counter must be found on display 2')
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
    // ROOT CAUSE: each codemode call started a new timeline. Even a help or
    // store query erased SDK calls and hid the previous desktop capture.
    const history = await page.evaluate(async () => {
      const state = window.playgroundState()
      const { cursorSeq, latestFramesAt } = await import('/playground/src/timeline.ts')
      return { calls: state.calls.map(call => call.id), frames: latestFramesAt(state, cursorSeq(state)).map(frame => frame.handle.$ref), seq: cursorSeq(state) }
    })
    const saved = await client.callTool({ arguments: { code: 'text(load("counterId")); text(typeof counter); text(typeof editorValue);' }, name: 'codemode' })
    assert.equal(saved.isError, false)
    assert.equal(saved.content.filter(item => item.type === 'text' && item.text === 'undefined').length, 2)
    const continued = await page.evaluate(async () => {
      const state = window.playgroundState()
      const { cursorSeq, latestFramesAt } = await import('/playground/src/timeline.ts')
      return { calls: state.calls.map(call => call.id), frames: latestFramesAt(state, cursorSeq(state)).map(frame => frame.handle.$ref), seq: cursorSeq(state) }
    })
    assert.deepEqual(continued.calls, history.calls, 'A call without SDK work must retain earlier calls')
    assert.deepEqual(continued.frames, history.frames, 'A call without captures must retain the latest desktop image')
    assert.ok(continued.seq > history.seq, 'Timeline positions must continue across codemode calls')
    await page.getByRole('tab', { exact: true, name: 'Variables' }).click()
    assert.match(await page.getByRole('tabpanel', { exact: true, name: 'Variables' }).textContent(), /Declared names show up here/, 'A fresh VM must not display variables from earlier scripts or the editor')
    await page.getByRole('tab', { name: /^Calls / }).click()
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
    const appended = await page.evaluate(() => window.playgroundState().calls.map(call => ({ id: call.id, script: call.script, seq: call.seq })))
    assert.deepEqual(appended.slice(0, history.calls.length).map(call => call.id), history.calls)
    assert.ok(appended[history.calls.length].seq > continued.seq, 'Later SDK calls must append after earlier events')
    assert.notEqual(appended.at(-1).script.id, appended[history.calls.length - 1].script.id)
    assert.match(appended[history.calls.length - 1].script.source, /for \(let i = 0; i < 3;/, 'Earlier calls must retain their original source')
    await page.locator(`[data-call-id="${history.calls.at(-1)}"] td`).first().click()
    await page.locator('summary').filter({ hasText: 'source' }).click()
    assert.match(await page.locator('details pre').textContent(), /for \(let i = 0; i < 3;/, 'The inspector must show the selected call source')
    const canceled = client.callTool({ arguments: { code: 'text("waiting"); await new Promise(() => {});', timeoutMs: 10000 }, name: 'codemode' })
    await page.waitForFunction(() => window.playgroundState().logs.some(log => log.values.includes('waiting')))
    await page.evaluate(() => window.codemodeHost.cancel())
    const canceledResult = await canceled
    assert.equal(canceledResult.isError, true)
    assert.ok(canceledResult.content.some(item => item.type === 'text' && item.text === 'waiting'), JSON.stringify(canceledResult))
    const transportAbort = new AbortController()
    const transportCanceled = client.callTool({ arguments: { code: 'text("transport waiting"); await new Promise(() => {});', timeoutMs: 10000 }, name: 'codemode' }, undefined, { signal: transportAbort.signal })
    await page.waitForFunction(() => window.playgroundState().logs.some(log => log.values.includes('transport waiting')))
    transportAbort.abort()
    await assert.rejects(transportCanceled)
    await page.waitForFunction(() => window.playgroundState().run.status === 'stopped')
    const loop = await client.callTool({ arguments: { code: 'while (true) {}', timeoutMs: 300 }, name: 'codemode' })
    assert.equal(loop.isError, true)
    assert.match(loop.content.at(-1).text, /timed out|interrupted/)
    const recovered = await client.callTool({ arguments: { code: 'return 7;' }, name: 'codemode' })
    assert.equal(recovered.isError, false)
    const allocation = await client.callTool({ arguments: { code: 'const values = new Array(1000000).fill("x"); text(values.length);' }, name: 'codemode' })
    assert.equal(allocation.isError, false, JSON.stringify(allocation))
    assert.ok(allocation.content.some(item => item.text === '1000000'))
    // NOTICE(codemode-trace-granularity): the owner retained complete statement
    // history. This optional probe reproduces its CPU-loop cost; it is not a
    // performance guarantee of the normal browser check.
    if (process.env.AUV_CODEMODE_BENCHMARK) {
      const busyStart = Date.now()
      const busy = await client.callTool({ arguments: { code: 'let sum=0; for(let i=0;i<1000000;i++){ sum+=i; } text(sum);', timeoutMs: 10000 }, name: 'codemode' })
      console.info('Million-iteration browser loop:', Date.now() - busyStart, 'ms')
      assert.equal(busy.isError, false, JSON.stringify(busy))
      assert.ok(busy.content.some(item => item.text === '499999500000'))
    }
    const malformed = await client.callTool({ arguments: { code: 'await auv.displays.captureRegion({ x: 0, y: 0, width: -10, height: -10 });' }, name: 'codemode' })
    assert.equal(malformed.isError, true)
    assert.match(malformed.content.at(-1).text, /positive/)
    const empty = await client.callTool({ arguments: { code: 'const win = await auv.windows.get("w-counter"); text((await win.findText("")).matches.length); text((await win.findText(" ")).matches.length);' }, name: 'codemode' })
    assert.equal(empty.isError, false)
    assert.equal(empty.content.filter(item => item.text === '0').length, 2)
    const editorRun = await page.evaluate(async () => (await import('/playground/src/runtime/session.ts')).session.run({ mode: 'run', source: 'editorValue;', startLine: 1 }))
    assert.equal(editorRun.value, 99)
    assert.equal(errors.length, 0, errors.join('\n'))
    const agentUi = await verifyAgentConnection(browser, vite.resolvedUrls.local[0], relay, result.content.find(item => item.type === 'image'))
    console.info(JSON.stringify({ agentUi, calls, cancellation: true, continuousHistoryAndDesktop: true, discoveryAndHelpExample: true, editorStatePreserved: true, images: true, mountedTabsPreserved: true, sourceHistory: true, stateRollback: true, timeoutAndRecovery: true, viewportFit: true }, null, 2))
  }
  finally {
    await client.close()
    await browser.close()
    await relay.close()
    await vite.close()
  }
}

void verifyBrowser().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
