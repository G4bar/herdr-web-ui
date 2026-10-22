import { describe, expect, it } from "bun:test";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { panelFrameUrl, panelFrameSrc, panelUrl, pushTarget, tabUrl, wantsPanel } from "./webPanel.ts";

const lan = { protocol: "http:", hostname: "100.123.228.51", origin: "http://100.123.228.51:7317" };
const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" };

describe("panelUrl", () => {
  it("names a loopback dev server under the host the browser used for the app", () => {
    expect(panelUrl("http://localhost:5173/", lan)).toBe("http://100.123.228.51:5173/");
    expect(panelUrl("http://127.0.0.1:3000/docs?x=1#top", lan)).toBe("http://100.123.228.51:3000/docs?x=1#top");
    expect(panelUrl("http://0.0.0.0:8080", lan)).toBe("http://100.123.228.51:8080/");
    expect(panelUrl("http://[::1]:4000/", lan)).toBe("http://100.123.228.51:4000/");
    expect(panelUrl("http://app.localhost:5173/", lan)).toBe("http://100.123.228.51:5173/");
    expect(panelUrl("http://localhost:5173/", local)).toBe("http://localhost:5173/");
  });

  it("frames another port of the app's own host as it is", () => {
    expect(panelUrl("http://100.123.228.51:5174/page", lan)).toBe("http://100.123.228.51:5174/page");
  });

  it("leaves every other host to a tab", () => {
    expect(panelUrl("https://github.com/devswha/ovis", lan)).toBeNull();
    expect(panelUrl("http://192.168.0.10:5173/", lan)).toBeNull();
    expect(panelUrl("http://localhost.example.com:5173/", lan)).toBeNull();
  });

  it("never frames the app itself, another scheme, or a malformed address", () => {
    expect(panelUrl("http://localhost:7317/", lan)).toBeNull();
    expect(panelUrl("http://100.123.228.51:7317/settings", lan)).toBeNull();
    expect(panelUrl("javascript:alert(1)", lan)).toBeNull();
    expect(panelUrl("file:///etc/hosts", lan)).toBeNull();
    expect(panelUrl("http://", lan)).toBeNull();
  });

  it("reaches a loopback page over the app's own https, but never over the app itself", () => {
    const tls = { protocol: "https:", hostname: "pc.tail.ts.net", origin: "https://pc.tail.ts.net" };
    const tlsApp = { protocol: "https:", hostname: "pc.tail.ts.net", origin: "https://pc.tail.ts.net:8443" };
    const tlsLocal = { protocol: "https:", hostname: "localhost", origin: "https://localhost:7317" };
    expect(panelUrl("http://localhost:5173/", tls)).toBe("https://pc.tail.ts.net:5173/");
    expect(panelUrl("http://127.0.0.1:3000/docs?x=1#top", tls)).toBe("https://pc.tail.ts.net:3000/docs?x=1#top");
    expect(panelUrl("http://127.0.0.1:7318/", tls)).toBe("https://pc.tail.ts.net:7318/");
    expect(panelUrl("https://localhost:5173/", tls)).toBe("https://pc.tail.ts.net:5173/");
    // the app's own port under the app's host is the app, at 443 or at its own https port
    expect(panelUrl("http://127.0.0.1:7317/", tls)).toBeNull();
    expect(panelUrl("http://localhost:7317/", tls)).toBeNull();
    expect(panelUrl("http://127.0.0.1:8443/", tlsApp)).toBeNull();
    // another site is mixed content, a named host's own http page is not ours to upgrade, and a
    // loopback app has no https of its own to lean on
    expect(panelUrl("http://example.com:5173/", tls)).toBeNull();
    expect(panelUrl("http://laptop.ts.net:5173/", { protocol: "https:", hostname: "laptop.ts.net", origin: "https://laptop.ts.net" })).toBeNull();
    expect(panelUrl("http://laptop.ts.net:7317/", { protocol: "https:", hostname: "laptop.ts.net", origin: "https://laptop.ts.net" })).toBeNull();
    expect(panelUrl("http://localhost:5173/", tlsLocal)).toBeNull();
    expect(panelUrl("https://localhost:5173/", tlsLocal)).toBe("https://localhost:5173/");
    // a root label changes nothing
    expect(panelUrl("http://localhost.:5173/", tls)).toBe("https://pc.tail.ts.net:5173/");
  });
});

describe("tabUrl", () => {
  const tailnet = { protocol: "https:", hostname: "pc.tail.ts.net", origin: "https://pc.tail.ts.net" };
  const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" };

  it("opens another site from anywhere, but this PC's loopback page only on this PC", () => {
    expect(tabUrl("https://example.com/x", tailnet)).toBe("https://example.com/x");
    expect(tabUrl("http://localhost:5173/", tailnet)).toBeNull();
    expect(tabUrl("http://localhost.:5173/", tailnet)).toBeNull();
    expect(tabUrl("http://localhost:5173/", local)).toBe("http://localhost:5173/");
    expect(tabUrl("javascript:alert(1)", local)).toBeNull();
  });
});

describe("pushTarget", () => {
  const lan = { protocol: "http:", hostname: "100.123.228.51", origin: "http://100.123.228.51:7317" };
  const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" };

  it("goes to the panel for a page the panel can frame, whatever the Web links setting says", () => {
    // no setting is read here: an explicit push named the panel itself
    expect(pushTarget("http://localhost:19432/", lan, true)).toEqual({ panel: "http://100.123.228.51:19432/" });
    expect(pushTarget("http://localhost:19432/", local, true)).toEqual({ panel: "http://localhost:19432/" });
    expect(pushTarget("http://100.123.228.51:5174/plan", lan, true)).toEqual({ panel: "http://100.123.228.51:5174/plan" });
  });

  it("falls back to a tab only when the panel cannot show the page or has no room", () => {
    // a narrow window has no panel to put it in
    expect(pushTarget("http://localhost:19432/", local, false)).toEqual({ tab: "http://localhost:19432/" });
    // an address the panel may not frame: another host, the app itself, another scheme
    expect(pushTarget("https://example.com/x", lan, true)).toEqual({ tab: "https://example.com/x" });
    expect(pushTarget("http://100.123.228.51:7317/settings", lan, true)).toEqual({ tab: "http://100.123.228.51:7317/settings" });
    expect(pushTarget("javascript:alert(1)", lan, true)).toBeNull();
  });

  it("opens nothing when even a tab would show another device's page", () => {
    const tailnet = { protocol: "https:", hostname: "pc.tail.ts.net", origin: "https://pc.tail.ts.net" };
    // over the app's https the panel still reaches that page; with no room for the panel, a tab
    // would show the device's own localhost, so nothing opens
    expect(pushTarget("http://localhost:19432/", tailnet, true)).toEqual({ panel: "https://pc.tail.ts.net:19432/" });
    expect(pushTarget("http://localhost:19432/", tailnet, false)).toBeNull();
  });
});

describe("panelFrameSrc", () => {
  it("keeps the address on its first showing, and marks every later one so the page is fetched again", () => {
    expect(panelFrameSrc("http://localhost:19432/", 0)).toBe("http://localhost:19432/");
    expect(panelFrameSrc("http://localhost:19432/plan?x=1#top", 1)).toBe("http://localhost:19432/plan?x=1&herdr-panel-reload=1#top");
    expect(panelFrameSrc("http://localhost:19432/", 2)).toBe("http://localhost:19432/?herdr-panel-reload=2");
    // every showing is its own address, so a stale one is never what the frame keeps
    expect(new Set([1, 2, 3].map((nonce) => panelFrameSrc("http://localhost:19432/", nonce))).size).toBe(3);
  });
});

describe("panelFrameUrl", () => {
  const frame = (machineId: string) => ({ type: "machine-message" as const, machine_id: machineId, message: { type: "web-panel-open" as const, url: "http://localhost:7399/" } });

  it("takes this PC's frame in a visible tab, and no other PC's", () => {
    expect(panelFrameUrl(frame(LOCAL_MACHINE), true)).toBe("http://localhost:7399/");
    expect(panelFrameUrl(frame("pc-b"), true)).toBeNull();
    expect(panelFrameUrl(frame(LOCAL_MACHINE), false)).toBeNull();
    expect(panelFrameUrl({ type: "machine-message", machine_id: LOCAL_MACHINE, message: { type: "error", code: "x", message: "y" } }, true)).toBeNull();
  });
});

describe("wantsPanel", () => {
  it("follows the setting, and Shift turns it around", () => {
    expect(wantsPanel("tab", false)).toBe(false);
    expect(wantsPanel("tab", true)).toBe(true);
    expect(wantsPanel("panel", false)).toBe(true);
    expect(wantsPanel("panel", true)).toBe(false);
  });
});
