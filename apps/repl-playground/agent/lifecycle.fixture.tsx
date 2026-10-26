import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '../src/App'

import 'virtual:uno.css'
import '../src/styles.css'

const container = document.getElementById('root')!
let root = createRoot(container)
root.render(<StrictMode><App /></StrictMode>)

// Rebuild only the view. A user-owned connection must survive its subscribers.
Object.assign(window, {
  remountAgentView() {
    root.unmount()
    root = createRoot(container)
    root.render(<StrictMode><App /></StrictMode>)
  },
})
