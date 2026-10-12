// Relay address for Mukae sign-in and agent sessions. `VITE_MUKAE_URL` is
// read at build time, mirroring the Example web app in lulu0119/mukae.
import { defaultRelayUrl } from '@mukae/contract'

export function mukaeRelayUrl(): string {
  const configured = import.meta.env.VITE_MUKAE_URL
  if (!configured)
    return defaultRelayUrl
  try {
    return new URL(configured).origin
  }
  catch {
    return defaultRelayUrl
  }
}
