import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'

import { defineConfig } from 'vite'

import { codeModeHelpPlugin } from './agent/help-catalog'

export default defineConfig({
  base: '/playground/',
  // NOTICE(worker-prebundle): discovering these imports on the first worker
  // execution reloads the page and disconnects its ACP tool call. Include
  // compiler and VM dependencies before the first execution starts.
  optimizeDeps: {
    include: ['@jitl/quickjs-singlefile-browser-release-sync', '@moeru/eventa/adapters/webworkers/worker', '@typescript/vfs', 'acorn', 'magic-string', 'quickjs-emscripten-core', 'ts-blank-space', 'typescript'],
  },
  plugins: [codeModeHelpPlugin(), UnoCSS(), react()],
  server: {
    port: 5180,
  },
  // Vitest runs in Node, where `@auv-js/sdk` would resolve its Node entry. The
  // REPL runs in the browser, so its tests import the same web entry.
  ssr: {
    resolve: {
      conditions: ['browser'],
    },
  },
  // Workers use dynamic imports (TypeScript lib chunks), so they must be ES modules.
  worker: {
    format: 'es',
    plugins: () => [codeModeHelpPlugin()],
  },
})
