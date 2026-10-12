/** Replaces the editor document; the Agent tab calls this for approved code blocks. */
export function applyScriptToEditor(source: string): void {
  document.dispatchEvent(new CustomEvent('playground:set-source', { detail: source }))
}
