/**
 * `/scoped-models` in the message box opens Settings on the Pi page and asks for its Scoped models
 * dialog (DS §4.12). The page owns that dialog — it holds Pi's model list and its settings file — so
 * the request is left here for it to read when it mounts, as a palette request steers Settings.
 */
let pending = false;

/** `/scoped-models`: Settings → Pi reads it once, when it mounts. */
export function requestScopedModels(): void {
  pending = true;
}

/** The request, if one is waiting: reading it clears it, so a later opening is not steered by it. */
export function takeScopedModelsRequest(): boolean {
  const asked = pending;
  pending = false;
  return asked;
}
