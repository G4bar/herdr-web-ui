/**
 * The Session context dialog is App's, for the selected pane (DS §4.10). The header's More menu
 * opens it from where App holds it; the palette and the empty chat's greeting line ask for it
 * through this store, so neither has to be handed the dialog's state.
 */
let open = false;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (open === value) return;
  open = value;
  for (const listener of listeners) listener();
}

export function openSessionContext(): void { set(true); }
export function closeSessionContext(): void { set(false); }

export function subscribeSessionContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function sessionContextOpen(): boolean { return open; }
