/**
 * The session tree is App's, for the selected pane (DS §4.9): `get_tree` answers it over RPC, so
 * only a pane the chat drives has one. The More menu opens it from where App holds it; the message
 * box (Esc Esc, `/tree`, `/fork`) and the palette ask for it through this store, so neither has to
 * be handed the dialog's state.
 */
let open = false;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (open === value) return;
  open = value;
  for (const listener of listeners) listener();
}

export function openSessionTree(): void { set(true); }
export function closeSessionTree(): void { set(false); }

export function subscribeSessionTree(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function sessionTreeOpen(): boolean { return open; }
