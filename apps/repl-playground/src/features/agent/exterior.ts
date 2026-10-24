import type { AccountSession } from '@exterioragentprotocol/sdk/client/react'

import type { AgentConnection } from './AgentSession'

import { browserCallbackPath } from '@exterioragentprotocol/sdk/client'
import { useAccount as useExteriorAccount } from '@exterioragentprotocol/sdk/client/react'

const defaultRelayUrl = 'http://127.0.0.1:8787'

export type { AccountSession }

/** A discoverable agent slot and the device's default ACP working directory. */
export interface AgentTarget {
  agentName: string
  cwd: string
  deviceId: string
  label: string
}

/** Normalize Exterior devices into selectable agent targets. */
export async function listTargets(listDevices: AccountSession['listDevices']): Promise<AgentTarget[]> {
  const devices = await listDevices()
  return devices.flatMap(device => device.agents.map(agent => ({
    agentName: agent.name,
    cwd: device.workingDirectory,
    deviceId: device.id,
    label: `${device.hostname} / ${agent.name}`,
  })))
}

/** Exchange an Exterior target for the transport contract consumed by ACP. */
export async function openAgentConnection(openConnection: AccountSession['openConnection'], target: AgentTarget): Promise<AgentConnection> {
  const ticket = await openConnection({ agentName: target.agentName, deviceId: target.deviceId })
  return { cwd: target.cwd, label: target.label, url: ticket.url }
}

/** Exterior owns sign-in; this adapter supplies the Playground callback route. */
export function useAccount(): AccountSession {
  // The playground is served below `/playground/`, but the upstream callback
  // assumes a root-served app. The sign-in flow itself lives upstream.
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  const callback = `${base}${browserCallbackPath.replace(/^\//, '')}`
  return useExteriorAccount(relayUrl(), {
    // NOTICE(exterior-client-identity): the relay must fetch this document over
    // HTTPS. Until publication, use the relay's app setup flow for a client id.
    clientId: import.meta.env.VITE_EXTERIOR_CLIENT_ID || 'https://auv.moeru.ai/playground/oauth-client.json',
    redirectUri: new URL(callback, window.location.origin).href,
    returnTo: base,
  })
}

// `VITE_EXTERIOR_URL` is a build-time relay origin. Use Exterior's local
// default when no valid override is configured, matching the upstream app.
function relayUrl(): string {
  const configured = import.meta.env.VITE_EXTERIOR_URL
  if (!configured)
    return defaultRelayUrl
  try {
    return new URL(configured).origin
  }
  catch {
    return defaultRelayUrl
  }
}
