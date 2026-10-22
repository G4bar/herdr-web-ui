import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseThemeBlocks, resolveEntry, ThemeValueError } from "./themeCss.ts";
import { SUPPORTED_ENTRIES } from "./themes.ts";

const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
const blocks = parseThemeBlocks(css);

type Rgb = [number, number, number];

/** DESIGN.md §2's ramp as sRGB weights (meta, dim, strong), the way `color-mix(in srgb, …)` mixes. */
const THINK: readonly (readonly [role: string, weights: readonly [number, number, number]])[] = [
  ["think-off", [0, 1, 0]],
  ["think-minimal", [0.25, 0.75, 0]],
  ["think-low", [0.5, 0.5, 0]],
  ["think-medium", [0.75, 0.25, 0]],
  ["think-high", [1, 0, 0]],
  ["think-xhigh", [0.7, 0, 0.3]],
];

const SURFACES = ["--bg", "--bg-panel", "--bg-elevated", "--bg-input"] as const;

function hex(value: string, entry: string, role: string): Rgb {
  if (!/^#[0-9a-f]{6}$/.test(value)) throw new ThemeValueError(entry, role, value, "not an opaque color");
  return [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16)) as Rgb;
}

function mix(parts: readonly Rgb[], weights: readonly number[]): Rgb {
  return [0, 1, 2].map((channel) => Math.round(parts.reduce((sum, part, index) => sum + part[channel]! * weights[index]!, 0))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

describe("warning and thinking tokens", () => {
  it("keeps --notice readable (WCAG AA 4.5:1) on every surface of every entry", () => {
    const failures: string[] = [];
    for (const { id, mode } of SUPPORTED_ENTRIES) {
      const entry = `${id}/${mode}`;
      const { resolved } = resolveEntry(blocks, id, mode);
      const notice = hex(resolved["--notice"] ?? "(missing)", entry, "notice");
      for (const surface of SURFACES) {
        const ratio = contrast(notice, hex(resolved[surface] ?? "(missing)", entry, surface.slice(2)));
        if (ratio < 4.5) failures.push(`${entry} notice on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("derives the thinking ramp and --custom-label from the palette and keeps them at AA on every surface", () => {
    const failures: string[] = [];
    for (const { id, mode } of SUPPORTED_ENTRIES) {
      const entry = `${id}/${mode}`;
      const { resolved } = resolveEntry(blocks, id, mode);
      const meta = hex(resolved["--syntax-meta"] ?? "(missing)", entry, "syntax-meta");
      const dim = hex(resolved["--text-dim"] ?? "(missing)", entry, "text-dim");
      const strong = hex(resolved["--text-strong"] ?? "(missing)", entry, "text-strong");
      const colors: readonly (readonly [string, Rgb])[] = [
        ...THINK.map(([role, weights]) => [role, mix([meta, dim, strong], weights)] as const),
        ["custom-label", meta] as const,
      ];
      for (const [role, color] of colors) {
        if (resolved[`--${role}`] === undefined) failures.push(`${entry} ${role}: not declared in :root`);
        for (const surface of SURFACES) {
          const ratio = contrast(color, hex(resolved[surface] ?? "(missing)", entry, surface.slice(2)));
          if (ratio < 4.5) failures.push(`${entry} ${role} on ${surface}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("declares the new tokens in :root only, never in a theme or palette block", () => {
    const names = ["--think-off", "--think-minimal", "--think-low", "--think-medium", "--think-high", "--think-xhigh", "--custom-label"];
    const root = blocks["amber/dark"]?.declared ?? {};
    expect(names.filter((name) => root[name] === undefined)).toEqual([]);
    for (const block of Object.values(blocks)) {
      if (block.id === "amber" && block.mode === "dark") continue;
      expect({ entry: `${block.id}/${block.mode}`, declared: names.filter((name) => block.declared[name] !== undefined) }).toEqual({ entry: `${block.id}/${block.mode}`, declared: [] });
    }
  });
});
