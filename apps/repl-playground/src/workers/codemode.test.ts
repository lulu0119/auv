import type { RunRequest } from '../runtime/protocol'

import { describe, expect, it } from 'vitest'

import { compileCell } from '../stepper/compile'
import { runCodeMode } from './codemode'

function request(source: string, store: Record<string, unknown> = {}, timeoutMs = 1000): RunRequest {
  return { ...compileCell(source, { allowReturn: true }), breakpoints: [], codemode: { store, timeoutMs }, executionId: 1, mode: 'run' }
}

const hooks = { __bind: () => {}, __step: async () => {}, __stepSync: () => {} }

describe('isolated codemode', () => {
  // A generic async bridge turned the SDK's synchronous windows.from()
  // into a Promise, so the next window operation could not be called.
  it('preserves synchronous window binding while its device methods remain asynchronous', async () => {
    const clicked: unknown[] = []
    const outcome = await runCodeMode(request('const counter = auv.windows.from("counter"); await counter.click({ x: 10, y: 20 });'), {
      ...hooks,
      auv: { windows: { from: () => ({ click: async (target: unknown) => clicked.push(target) }) } },
    }, new AbortController().signal)
    expect(outcome).toMatchObject({ status: 'ok' })
    expect(clicked).toEqual([{ x: 10, y: 20 }])
  })

  it('keeps SDK error names and RPC codes available to the script', async () => {
    const error = Object.assign(new Error('missing window'), { name: 'AuvRpcError', rpcCode: 5 })
    const outcome = await runCodeMode(request('try { await auv.call(); } catch (error) { text({ name: error.name, rpcCode: error.rpcCode }); }'), {
      ...hooks,
      auv: { call: async () => { throw error } },
    }, new AbortController().signal)
    expect(outcome.status).toBe('ok')
    expect(outcome.codemode?.content).toEqual([{ text: '{"name":"AuvRpcError","rpcCode":5}', type: 'text' }])
  })

  it('composes SDK-shaped calls and returns only explicit output', async () => {
    const inputs: unknown[] = []
    const outcome = await runCodeMode(request(`
      const win = await auv.windows.resolve({ appName: 'Counter' });
      const matches = await win.findText('Increment');
      await win.click(matches[0]);
      text({ clicked: matches.length });
    `), { ...hooks, auv: { windows: { resolve: async () => ({ click: async (target: unknown) => inputs.push(target), findText: async () => [{ x: 10, y: 20 }] }) } } }, new AbortController().signal)
    expect(outcome).toMatchObject({ status: 'ok' })
    expect(inputs).toEqual([{ x: 10, y: 20 }])
    expect(outcome.codemode?.content).toEqual([{ text: '{"clicked":1}', type: 'text' }])
  })

  it('isolates browser globals and does not retain variables across calls', async () => {
    const first = await runCodeMode(request('const secret = 42; text([typeof fetch, typeof indexedDB, typeof postMessage, typeof process]);'), hooks, new AbortController().signal)
    expect(first.codemode?.content).toEqual([{ text: '["undefined","undefined","undefined","undefined"]', type: 'text' }])
    const second = await runCodeMode(request('text(typeof secret)'), hooks, new AbortController().signal)
    expect(second.codemode?.content?.[0]).toEqual({ text: 'undefined', type: 'text' })
  })

  it('commits small JSON state on success and keeps old state on failure', async () => {
    const first = await runCodeMode(request('store("windowId", "counter"); return load("windowId");'), hooks, new AbortController().signal)
    expect(first.codemode?.store).toEqual({ windowId: 'counter' })
    expect(first.codemode?.content).toEqual([{ text: 'counter', type: 'text' }])
    const failed = await runCodeMode(request('store("windowId", "other"); text("before failure"); throw new Error("broken");', first.codemode!.store), hooks, new AbortController().signal)
    expect(failed.status).toBe('error')
    expect(failed.codemode?.store).toEqual({ windowId: 'counter' })
    expect(failed.codemode?.content).toEqual([{ text: 'before failure', type: 'text' }])
  })

  it('bounds output before returning a large SDK result to the model', async () => {
    const outcome = await runCodeMode(request('text("small"); text("x".repeat(16001));'), hooks, new AbortController().signal)
    expect(outcome.status).toBe('error')
    expect(outcome.codemode?.content).toEqual([{ text: 'small', type: 'text' }])
  })

  it('interrupts synchronous loops at the deadline', async () => {
    const outcome = await runCodeMode(request('while (true) {}', {}, 30), hooks, new AbortController().signal)
    expect(outcome.status).toBe('error')
  })

  it('cancels a pending asynchronous call', async () => {
    const abort = new AbortController()
    const pending = runCodeMode(request('await auv.wait();'), { ...hooks, auv: { wait: () => new Promise(() => {}) } }, abort.signal)
    setTimeout(() => abort.abort(), 20)
    const outcome = await pending
    expect(outcome.status).toBe('error')
    expect(outcome.status === 'error' && outcome.message).toContain('canceled')
  })

  it('explicitly rejects unsupported SDK callback arguments', async () => {
    let called = false
    const outcome = await runCodeMode(request('await auv.call({ until: () => true });'), { ...hooks, auv: { call: async () => {
      called = true
    } } }, new AbortController().signal)
    expect(outcome.status).toBe('error')
    expect(called).toBe(false)
    expect(outcome.status === 'error' && outcome.message).toContain('callbacks')
  })

  it('emits pixels only through an explicit image request', async () => {
    const images: unknown[] = []
    const outcome = await runCodeMode(request('await image({ captureId: "cap-1" });'), { ...hooks, image: async (capture: unknown) => {
      images.push(capture)
      return { data: 'aGVsbG8=', mimeType: 'image/png' }
    } }, new AbortController().signal)
    expect(images).toEqual([{ captureId: 'cap-1' }])
    expect(outcome.codemode?.content).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' }])
  })
})
