import { describe, expect, it } from "bun:test";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { panelFrameUrl, panelUrl, tabUrl, wantsPanel } from "./webPanel.ts";

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
    expect(panelUrl("https://github.com/devswha/herdr-web-ui", lan)).toBeNull();
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
    // another site is mixed content, and a loopback app has no https of its own to lean on
    expect(panelUrl("http://example.com:5173/", tls)).toBeNull();
    expect(panelUrl("http://localhost:5173/", tlsLocal)).toBeNull();
    expect(panelUrl("https://localhost:5173/", tlsLocal)).toBe("https://localhost:5173/");
  });
});

describe("tabUrl", () => {
  const tailnet = { protocol: "https:", hostname: "pc.tail.ts.net", origin: "https://pc.tail.ts.net" };
  const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" };

  it("opens another site from anywhere, but this PC's loopback page only on this PC", () => {
    expect(tabUrl("https://example.com/x", tailnet)).toBe("https://example.com/x");
    expect(tabUrl("http://localhost:5173/", tailnet)).toBeNull();
    expect(tabUrl("http://localhost:5173/", local)).toBe("http://localhost:5173/");
    expect(tabUrl("javascript:alert(1)", local)).toBeNull();
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
