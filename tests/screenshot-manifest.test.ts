import { describe, it, expect } from "vitest";
import { SHOTS, demoPath, fillPath, imageLinks, splitPath, validateManifest, type Shot } from "../scripts/screenshots/shots.js";
import { PREPARE } from "./browser/guide-prepare.js";

const shot = (name: string, over: Partial<Shot> = {}): Shot => ({
  name, guide: "user", role: "user", path: "/user/", expect: "Start work", ...over,
});

describe("screenshot manifest", () => {
  it("accepts a clean manifest", () => {
    expect(validateManifest([shot("a"), shot("b")], { a: async () => {} })).toEqual([]);
  });
  it("reports duplicate names", () => {
    expect(validateManifest([shot("a"), shot("a")])).toEqual(["duplicate shot: a"]);
  });
  it("reports prepare keys that are not shots", () => {
    expect(validateManifest([shot("a")], { zzz: 1 })).toEqual(["prepare step for unknown shot: zzz"]);
  });
  it("reports a shot with no expected locator", () => {
    expect(validateManifest([shot("a", { expect: " " })])).toEqual(["shot without an expected locator: a"]);
  });
  it("the real manifest is valid", () => {
    expect(validateManifest(SHOTS)).toEqual([]);
    expect(validateManifest(SHOTS, PREPARE)).toEqual([]);
    expect(SHOTS.map((s) => s.name)).toEqual(["sign-in", "board", "runs", "flows", "flow-yaml", "library", "models",
      "run-dialog", "run-log", "run-steps", "run-diff", "run-waiting", "settings", "dashboard", "repos", "watchers", "watcher-form", "home", "user-home"]);
    expect(Object.keys(PREPARE)).toEqual(["flow-yaml", "run-dialog", "run-log", "run-steps", "run-diff", "watcher-form", "home"]);
  });
  it("the Home shots have the agreed fields", () => {
    expect(SHOTS.slice(-2)).toEqual([
      { name: "home", guide: "admin", role: "admin", path: "/#/home", expect: "Seeded gate run" },
      { name: "user-home", guide: "user", role: "user", path: "/user/#/home", expect: "Seeded failed run" },
    ]);
  });
  it("uses only known placeholders", () => {
    for (const s of SHOTS) {
      for (const m of s.path.matchAll(/\{([^}]+)\}/g)) {
        expect(["waiting", "diffRun"], `${s.name} uses {${m[1]}}`).toContain(m[1]);
      }
    }
  });
  it("a shot with {diffRun} opens on the large server", () => {
    const withDiff = SHOTS.filter((s) => s.path.includes("{diffRun}"));
    expect(withDiff.length).toBeGreaterThan(0);
    for (const s of withDiff) expect(PREPARE[s.name]?.large, s.name).toBe(true);
  });
  it("only {diffRun} shots use the large server", () => {
    for (const [name, p] of Object.entries(PREPARE)) {
      if (p.large) expect(SHOTS.find((s) => s.name === name)?.path, name).toContain("{diffRun}");
    }
  });
  it("every prepare entry of this part has a step", () => {
    for (const n of ["run-dialog", "run-log", "run-steps", "run-diff", "watcher-form", "home"]) {
      expect(typeof PREPARE[n]?.act, n).toBe("function");
    }
  });
  it("reports a bad shot name", () => {
    expect(validateManifest([shot("Bad_Name")])).toEqual(["bad shot name: Bad_Name"]);
    expect(validateManifest([shot("a b")])).toEqual(["bad shot name: a b"]);
  });
  it("reports a path that does not fit its role", () => {
    for (const over of [
      { role: "none", path: "/#/home" }, { role: "admin", path: "/user/" },
      { role: "admin", path: "/" }, { role: "user", path: "/#/runs" },
    ] as const) {
      expect(validateManifest([shot("a", over)])).toEqual(["shot path does not fit its role: a"]);
    }
  });
  it("accepts paths that fit", () => {
    expect(validateManifest([shot("a", { role: "none", path: "/" })])).toEqual([]);
    expect(validateManifest([shot("a", { role: "admin", path: "/#/board" })])).toEqual([]);
  });
});

describe("fillPath and splitPath", () => {
  it("fills placeholders", () => {
    expect(fillPath("/#/runs/{failed}", { failed: "ui-failed" })).toBe("/#/runs/ui-failed");
    expect(fillPath("/#/{a}/{b}", { a: "x", b: "y" })).toBe("/#/x/y");
    expect(fillPath("/#/board", {})).toBe("/#/board");
  });
  it("throws for an unknown placeholder", () => {
    expect(() => fillPath("/#/runs/{nope}", {})).toThrow("unknown placeholder {nope} in /#/runs/{nope}");
  });
  it("splits at the first #", () => {
    expect(splitPath("/#/home")).toEqual({ display: "/", hash: "#/home" });
    expect(splitPath("/user/#/repos")).toEqual({ display: "/user/", hash: "#/repos" });
    expect(splitPath("/")).toEqual({ display: "/", hash: "" });
  });
});

describe("demoPath", () => {
  const T = "/var/folders/ab/cd/T/ui-harness-AbC123";
  const root = "/Users/x/work/checkout";
  const home = "/Users/x";
  const d = (t: string) => demoPath(t, root, home);
  it("rewrites the temporary folder", () => {
    expect(d(`${T}/repo`)).toBe("~/code/my-project");
    expect(d(`Repository: ${T}/repo (git)`)).toBe("Repository: ~/code/my-project (git)");
    expect(d(`${T}/home/config.json`)).toBe("~/.spaghetti-code-foundry/config.json");
    expect(d(`${T}/runs/ui-failed`)).toBe("~/.spaghetti-code-foundry/runs/ui-failed");
    expect(d(T)).toBe("~");
    expect(d(`${T}/other`)).toBe("~/other");
    expect(d("ui-harness-AbC123")).toBe("~");
    expect(d(`/private${T}/repo`)).toBe("~/code/my-project");
    expect(d(`${T}/repo and ${T}/runs/x`)).toBe("~/code/my-project and ~/.spaghetti-code-foundry/runs/x");
  });
  it("rewrites the checkout and the home folder", () => {
    expect(d(`${root}/src/a.ts`)).toBe("~/spaghetti-code-foundry/src/a.ts");
    expect(d("/Users/x/Documents")).toBe("~/Documents");
  });
  it("leaves other text alone", () => {
    expect(d("No runs yet.")).toBe("No runs yet.");
    expect(demoPath(`${T}/x /a`, "", "")).toBe("~/x /a");
    expect(demoPath("/a/b", "", "")).toBe("/a/b");
  });
});

describe("imageLinks", () => {
  it("lists image names in order, duplicates kept", () => {
    expect(imageLinks("![a](images/board.png) text ![b](docs/images/flows.png)")).toEqual(["board.png", "flows.png"]);
    expect(imageLinks("![a](images/board.png)\n![b](images/board.png)")).toEqual(["board.png", "board.png"]);
  });
  it("ignores other links", () => {
    expect(imageLinks("![x](http://example.com/images/y.png)")).toEqual([]);
    expect(imageLinks("![x](other/z.png)")).toEqual([]);
    expect(imageLinks("[t](images/q.png)")).toEqual([]);
  });
});
