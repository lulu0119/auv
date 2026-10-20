import { afterEach, describe, expect, it, vi } from 'vitest'

import { listTargets, openAgentConnection, useAccount } from './exterior'

const upstream = vi.hoisted(() => ({ listDevices: vi.fn(), openConnection: vi.fn(), useAccount: vi.fn() }))
vi.mock('@exterior/client', () => ({ browserCallbackPath: '/oauth/callback', listDevices: upstream.listDevices, openConnection: upstream.openConnection }))
vi.mock('@exterior/client/react', () => ({ useAccount: upstream.useAccount }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('exterior connection adapter', () => {
  it('preserves the device working directory when discovering and connecting an agent', async () => {
    const cwd = String.raw`C:\Users\owner\repo`
    vi.stubEnv('VITE_EXTERIOR_URL', 'https://relay.example/path')
    upstream.listDevices.mockResolvedValue([
      { agents: [], hostname: 'empty', id: 'empty', platform: 'linux', workingDirectory: '/home/empty' },
      { agents: [{ agentType: 'custom', name: 'auv' }], hostname: 'workstation', id: 'device', platform: 'windows', workingDirectory: cwd },
    ])
    upstream.openConnection.mockResolvedValue({ agentName: 'auv', agentType: 'custom', url: 'wss://relay.example/ticket' })
    const targets = await listTargets('account-token')
    expect(upstream.listDevices).toHaveBeenCalledWith('https://relay.example', 'account-token')
    expect(targets).toEqual([{ agentName: 'auv', cwd, deviceId: 'device', label: 'workstation / auv' }])
    const connection = await openAgentConnection('account-token', targets[0]!)
    expect(upstream.openConnection).toHaveBeenCalledWith('https://relay.example', 'account-token', { agentName: 'auv', deviceId: 'device' })
    expect(connection).toEqual({ cwd, label: 'workstation / auv', url: 'wss://relay.example/ticket' })
  })

  it('keeps the OAuth callback under the Playground base path', () => {
    vi.stubGlobal('window', { location: { origin: 'https://playground.example' } })
    vi.stubEnv('BASE_URL', '/playground/')
    vi.stubEnv('VITE_EXTERIOR_URL', 'https://relay.example')
    const account = { account: { phase: 'signed-out' } }
    upstream.useAccount.mockReturnValue(account)
    expect(useAccount()).toBe(account)
    expect(upstream.useAccount).toHaveBeenCalledWith('https://relay.example', {
      redirectUri: 'https://playground.example/playground/oauth/callback',
      returnTo: '/playground/',
    })
  })

  it('uses the upstream local relay default without a valid override', async () => {
    vi.stubEnv('VITE_EXTERIOR_URL', 'invalid origin')
    upstream.listDevices.mockResolvedValue([])
    expect(await listTargets('account-token')).toEqual([])
    expect(upstream.listDevices).toHaveBeenCalledWith('http://127.0.0.1:8787', 'account-token')
  })

  it('reports ticket failures without manufacturing a connection', async () => {
    upstream.openConnection.mockRejectedValue(new Error('Device is offline'))
    await expect(openAgentConnection('account-token', { agentName: 'auv', cwd: '/home/owner', deviceId: 'device', label: 'owner / auv' })).rejects.toThrow('Device is offline')
  })
})
