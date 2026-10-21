import { createContext } from "react";
import { LOCAL_MACHINE, type MachineEvent } from "../../shared/machines.ts";

export const WEB_LINK_TARGETS = ["tab", "panel"] as const;
export type WebLinkTarget = (typeof WEB_LINK_TARGETS)[number];

export interface AppLocation {
  protocol: string;
  hostname: string;
  origin: string;
}

/** Names a pane prints for the PC it runs on: a dev server's own "Local: http://localhost:5173/". */
const LOOPBACK = /^(?:localhost|[^.]+(?:\.[^.]+)*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

/** The port the app listens on: shared/protocol.ts `DEFAULT_PORT`, which the client may not import. */
const APP_PORT = 7317;

/**
 * The address the panel frames for `uri`, or null when it opens in a tab. Only a page served
 * by the PC this app runs on is framed, on another port than the app's: the app's policy
 * (server/static.ts) frames that host alone, and most other sites refuse to be framed anyway.
 * A loopback name means that PC, so it is reached under the host the browser used for the app:
 * from another computer, `localhost:5173` would be that computer's own. An https app frames such a
 * page over its own https, when its setup serves that port under the host as well; any other http
 * page cannot be framed (mixed content) and opens in a tab.
 */
export function panelUrl(uri: string, app: AppLocation): string | null {
  if (!/^https?:\/\//i.test(uri)) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const loopback = LOOPBACK.test(url.hostname);
  if (loopback) url.hostname = app.hostname;
  else if (url.hostname.toLowerCase() !== app.hostname.toLowerCase()) return null;
  if (url.origin === app.origin) return null;
  if (app.protocol === "https:" && url.protocol === "http:") {
    // The https is the app's, so only a named host has one, and it is not a page on the app's own port:
    // that address is the app itself, and a loopback app has no other https to lean on.
    if (loopback && (LOOPBACK.test(app.hostname) || url.port === String(APP_PORT))) return null;
    url.protocol = "https:";
    if (url.origin === app.origin) return null;
  }
  return url.href;
}

/**
 * The page a `web-panel-open` frame asks for, or null to leave it alone: only a page of the PC this
 * app runs on (a remote PC's is that PC's panel), and only in a tab the user is looking at, since a
 * hidden one would take over the page they come back to.
 */
export function panelFrameUrl(event: Extract<MachineEvent, { type: "machine-message" }>, visible: boolean): string | null {
  if (!visible || event.machine_id !== LOCAL_MACHINE || event.message.type !== "web-panel-open") return null;
  return event.message.url;
}

/**
 * The address to open in a tab when the panel cannot frame it, or null to open nothing: a loopback
 * address is the PC that serves it, so on a device that reached this app elsewhere it means that
 * device, not the page.
 */
export function tabUrl(uri: string, app: AppLocation): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  return LOOPBACK.test(url.hostname) && !LOOPBACK.test(app.hostname) ? null : uri;
}

export function wantsPanel(target: WebLinkTarget, shiftKey: boolean): boolean {
  return (target === "panel") !== shiftKey;
}

/**
 * Opens a web address in the panel beside the pane when the setting (or Shift) asks for it and the
 * address can be framed; answers false when it did not, and the caller opens it in a new tab.
 * Null where no panel can show (a narrow window); `machineId` is the PC whose pane named the address.
 */
export const WebPanelContext = createContext<((uri: string, shiftKey: boolean, machineId: string) => boolean) | null>(null);
