import type { AccountSession } from '@mukae/client/react'

import { browserCallbackPath } from '@mukae/client'
import { useAccount as useUpstreamAccount } from '@mukae/client/react'

export type { AccountSession }

// The playground is served below `/playground/`, but the upstream callback
// assumes a root-served app, so the addresses are computed here and handed
// in. The sign-in flow itself lives upstream.
export function useAccount(relayUrl: string): AccountSession {
  return useUpstreamAccount(relayUrl, { redirectUri: callbackUrl(), returnTo: import.meta.env.BASE_URL })
}

/** OAuth callback address under this app's base. */
function callbackPath(): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  return `${base}${browserCallbackPath.replace(/^\//, '')}`
}

function callbackUrl(): string {
  return new URL(callbackPath(), window.location.origin).href
}
