import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withApiVersion } from "../scripts/release-notes.mjs";

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p), "utf8");
const pkg = JSON.parse(read("package.json"));
const snapshotPath = root("tests/public-api.snapshot.json");

interface Snapshot { apiVersion: string; exports: Record<string, string> }

function parseVersion(v: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Names and kinds of the public API: values from the module, types from the text of the entry file. */
export function surface(mod: Record<string, unknown>, indexText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function") {
      out[name] = /^class\s/.test(Function.prototype.toString.call(value)) ? "class" : `function/${value.length}`;
    } else {
      out[name] = typeof value;
    }
  }
  for (const m of indexText.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name) out[name] = "type";
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

type Change = { ok: true } | { ok: false; message: string; canUpdate: boolean };

export function apiChange(old: Snapshot, now: Record<string, string>, pkgVersion: string): Change {
  const v = parseVersion(pkgVersion);
  const o = parseVersion(old.apiVersion);
  if (!v || !o) return { ok: false, message: `Bad version: package "${pkgVersion}", snapshot "${old.apiVersion}"`, canUpdate: false };
  const added = Object.keys(now).filter((n) => !(n in old.exports));
  const broken = Object.keys(old.exports).filter((n) => now[n] !== old.exports[n]);
  if (!added.length && !broken.length) return { ok: true };
  const moved = v[0] > o[0] || (v[0] === o[0] && v[1] > o[1]);
  const what = `added: [${added.join(", ")}], removed or changed: [${broken.join(", ")}]`;
  if (!moved) {
    return { ok: false, canUpdate: false, message: `The public API changed (${what}). Raise the minor (or major) version in package.json, then update the snapshot (SCF_UPDATE_API_SNAPSHOT=1).` };
  }
  if (broken.length && v[0] >= 1 && v[0] === o[0]) {
    return { ok: false, canUpdate: false, message: `Names were removed or changed (${what}). That needs a new major version.` };
  }
  return { ok: false, canUpdate: true, message: `The public API changed (${what}). Update the snapshot (SCF_UPDATE_API_SNAPSHOT=1).` };
}

const snapshot: Snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

describe("package shape", () => {
  it("is the public package", () => {
    expect(pkg.name).toBe("@melomar-it/scf-core");
    expect(pkg.publishConfig.registry).toBe("https://npm.pkg.github.com");
    expect(pkg.exports).toEqual({ ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
    expect(pkg.bin).toEqual({ scf: "dist/cli.js", factory: "dist/factory.js" });
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("docs/PLUGIN_API.md");
    expect(JSON.parse(read("tsconfig.build.json")).compilerOptions.declaration).toBe(true);
  });
  it("has no export * in the entry file", () => {
    expect(read("src/index.ts")).not.toMatch(/export\s*\*/);
  });
  it("has a publish workflow with the agreed shape", () => {
    const wf = read(".github/workflows/publish.yml");
    expect(wf).toContain('tags: ["v*.*.*"]');
    expect(wf).toContain("group: publish-${{ github.ref_name }}");
    expect(wf).toContain("cancel-in-progress: false");
    expect(wf).toMatch(/\n {2}notes:\n {4}needs: publish/);
    expect(wf).toContain("NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });
});

describe("public API snapshot", () => {
  it("matches the real exports", async () => {
    const mod = (await import("../src/index.js")) as Record<string, unknown>;
    const now = surface(mod, read("src/index.ts"));
    if (JSON.stringify(now) !== JSON.stringify(snapshot.exports)) {
      const c = apiChange(snapshot, now, pkg.version);
      if (c.ok) throw new Error("unreachable");
      if (process.env.SCF_UPDATE_API_SNAPSHOT === "1" && c.canUpdate) {
        const [maj, min] = parseVersion(pkg.version)!;
        writeFileSync(snapshotPath, JSON.stringify({ apiVersion: `${maj}.${min}`, exports: now }, null, 2) + "\n");
        return;
      }
      throw new Error(c.message);
    }
    expect(now).toEqual(snapshot.exports);
  });
  it("links PLUGIN_API_VERSION to the snapshot and the package version", async () => {
    const mod = (await import("../src/index.js")) as Record<string, unknown>;
    expect(mod.PLUGIN_API_VERSION).toBe(snapshot.apiVersion);
    const [a, b] = parseVersion(snapshot.apiVersion)!;
    const [x, y] = parseVersion(pkg.version)!;
    expect(a < x || (a === x && b <= y)).toBe(true);
  });
});

describe("surface", () => {
  it("names kinds", () => {
    class A {}
    function f(_x: unknown, _y: unknown) {}
    const s = surface({ A, f, o: {}, s: "x" }, "export type { T, U as V } from './x.js';");
    expect(s).toEqual({ A: "class", T: "type", V: "type", f: "function/2", o: "object", s: "string" });
  });
});

describe("apiChange", () => {
  const old = (apiVersion: string): Snapshot => ({ apiVersion, exports: { a: "function/1", b: "type" } });
  const same = { a: "function/1", b: "type" };
  const plus = { ...same, c: "type" };
  it("accepts equal exports", () => {
    expect(apiChange(old("0.1"), same, "0.3.0")).toEqual({ ok: true });
  });
  it("rejects additions without a minor bump", () => {
    expect(apiChange(old("0.1"), plus, "0.1.0")).toMatchObject({ ok: false, canUpdate: false });
    expect(apiChange(old("0.1"), plus, "0.1.1")).toMatchObject({ ok: false, canUpdate: false });
  });
  it("allows additions with a minor bump", () => {
    expect(apiChange(old("0.1"), plus, "0.2.0")).toMatchObject({ ok: false, canUpdate: true, message: expect.stringContaining("Update the snapshot") });
  });
  it("allows removals before 1.0 with a minor bump", () => {
    expect(apiChange(old("0.1"), { b: "type" }, "0.2.0")).toMatchObject({ canUpdate: true });
  });
  it("needs a major bump for removals and changes from 1.0", () => {
    const removed = apiChange(old("1.2"), { b: "type" }, "1.3.0");
    expect(removed).toMatchObject({ ok: false, canUpdate: false });
    expect((removed as { message: string }).message).toContain("new major version");
    expect(apiChange(old("1.2"), { ...same, a: "function/2" }, "1.3.0")).toMatchObject({ canUpdate: false });
    expect(apiChange(old("1.2"), { b: "type" }, "2.0.0")).toMatchObject({ canUpdate: true });
  });
  it("rejects a bad version", () => {
    expect(apiChange(old("0.1"), plus, "nope")).toMatchObject({ ok: false, canUpdate: false });
  });
});

describe("withApiVersion", () => {
  const line = "Plugin API: 0.1 (see docs/PLUGIN_API.md)\n";
  it("handles an empty body", () => {
    expect(withApiVersion("", "0.1")).toBe(line);
  });
  it("appends after a blank line", () => {
    expect(withApiVersion("Notes\n", "0.1")).toBe(`Notes\n\n${line}`);
  });
  it("replaces an old line", () => {
    const out = withApiVersion("Notes\n\nPlugin API: 0.0 (see docs/PLUGIN_API.md)\n", "0.1");
    expect(out).toBe(`Notes\n\n${line}`);
    expect(out.match(/Plugin API:/g)).toHaveLength(1);
  });
  it("rejects a bad version", () => {
    for (const v of ["1", "1.2.3", "x; rm"]) expect(() => withApiVersion("", v)).toThrow();
  });
});
