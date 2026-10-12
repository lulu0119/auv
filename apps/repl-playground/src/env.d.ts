/// <reference types="vite/client" />

declare module '*.d.txt?raw' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  /** Mukae relay origin for Agent sign-in; defaults to the local relay. */
  readonly VITE_MUKAE_URL?: string
}
