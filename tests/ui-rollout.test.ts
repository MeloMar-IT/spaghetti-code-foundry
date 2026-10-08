import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";
import { code, tableRows } from "./helpers/md-table.js";

// Route compatibility for #401: every address of the frozen inventory still opens a page of ui/ia.js and not the
// unknown-address fallback. GitHub status comments write run ids as plain text (src/queue/status-comment.ts), so
// only the links the notifier writes are checked here.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ia: any;
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  ia = await import("../ui/ia.js" as string);
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

const inventory = readFileSync("docs/ui-redesign/inventory.md", "utf8");
const fill = (route: string) => route.replace(/:\w+/, "x-1");
const RUN = "20261008-064205-0313";

describe("route compatibility", () => {
  it("opens the page of every admin route of the inventory", () => {
    const routes = tableRows(inventory, "## Admin display").map((r) => code(r[0]!));
    expect(routes.length).toBeGreaterThanOrEqual(22);
    for (const route of routes) {
      const to = ia.resolve("admin", fill(route));
      expect(to.reason, route).toBeNull();
      expect(to.redirected, route).toBe(false);
      expect(to.hash, route).toBe(fill(route));
      expect(to.page.path, route).toBe(route);
    }
  });

  it("opens the page of every user route of the inventory", () => {
    const routes = tableRows(inventory, "## User display").map((r) => code(r[0]!));
    expect(routes.length).toBeGreaterThanOrEqual(7);
    for (const route of routes) {
      expect(route.startsWith("/user/"), route).toBe(true);
      const h = fill(route.slice("/user/".length));
      expect(ia.resolve("user", h).reason, route).toBeNull();
      expect(auth.isUserHash(h), route).toBe(true);
    }
  });

  it("sends the old #/your-turn to Home", () => {
    expect(inventory).toContain("`#/your-turn`");
    const to = ia.resolve("admin", "#/your-turn");
    expect(to).toMatchObject({ hash: "#/home", reason: "alias" });
    expect(to.page.id).toBe("home");
  });

  it("tells the unknown-address fallback apart", () => {
    expect(ia.resolve("admin", "#/nope").reason).toBe("unknown");
    expect(ia.resolve("user", "#/users").reason).toBe("unknown");
  });

  it("handles the set-password link before the router", () => {
    expect(inventory).toContain("`#/set-password/:token`");
    expect(auth.linkToken("#/set-password/abc_DEF-1")).toBe("abc_DEF-1");
  });

  it("opens a run link on both displays", () => {
    for (const role of ["admin", "user"]) {
      const to = ia.resolve(role, "#/runs/" + RUN);
      expect(to, role).toMatchObject({ redirected: false, arg: RUN, back: "#/runs" });
      expect(to.page.id, role).toBe("run");
    }
    expect(auth.isUserHash("#/runs/" + RUN)).toBe(true);
    expect(auth.otherDisplay({ role: "user" }, "admin", "#/runs/" + RUN)).toBe("/user/#/runs/" + RUN);
    expect(auth.otherDisplay({ role: "admin" }, "user", "#/runs/" + RUN)).toBe("/#/runs/" + RUN);
  });

  it("resolves the links the notifier writes", () => {
    const src = readFileSync("src/server/notifier.ts", "utf8");
    const hashes = [...src.matchAll(/\$\{d\.baseUrl\}\/(#\/[\w-]+(?:\/\$\{[^}]+\})?)/g)].map((m) => m[1]!.replace(/\$\{[^}]+\}/, RUN));
    expect(hashes.length).toBeGreaterThanOrEqual(3);
    expect(hashes).toContain("#/runs/" + RUN);
    for (const h of hashes) expect([null, "alias"], h).toContain(ia.resolve("admin", h).reason);
    const run = "#/runs/" + RUN;
    expect(ia.resolve("admin", run).page.id).toBe("run");
    expect(auth.isUserHash(run)).toBe(true);
    expect(ia.resolve("user", run).page.id).toBe("run");
  });
});
