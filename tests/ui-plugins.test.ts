import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ia: any;
let auth: any;
let plugins: any;
beforeAll(async () => {
  restore = installFakeDom();
  ia = await import("../ui/ia.js" as string);
  auth = await import("../ui/auth.js" as string);
  plugins = await import("../ui/plugins.js" as string);
});
afterAll(() => restore());
afterEach(() => ia.setPluginPages([]));

const PAGES = [
  { plugin: "acme", id: "report", title: "Report", module: "/plugins/acme/report.js", roles: ["user", "admin"] },
  { plugin: "acme", id: "secret", title: "Secret", module: "/plugins/acme/secret.js", roles: ["admin"] },
];
const section = (title: string, ...children: unknown[]) => {
  const el = new FakeElement("div");
  const h3 = new FakeElement("h3");
  h3.append(title);
  el.append(h3, ...(children.flat(Infinity).filter(Boolean) as FakeElement[]));
  return el;
};

describe("plugin pages in the information architecture", () => {
  it("resolves a registered page for both displays and draws it without a destination", () => {
    ia.setPluginPages(PAGES);
    for (const role of ["user", "admin"]) {
      const to = ia.resolve(role, "#/plugins/acme/report");
      expect(to).toMatchObject({ redirected: false, hash: "#/plugins/acme/report", dest: null, title: "Report", page: { nav: "plugin", plugin: "acme", pageId: "report", module: "/plugins/acme/report.js" } });
      expect(to.crumbs).toEqual([]);
    }
    expect(ia.hasPluginPage("acme", "report")).toBe(true);
    expect(ia.hasPluginPage("acme", "nope")).toBe(false);
  });

  it("falls back as for any unknown address, in both displays", () => {
    ia.setPluginPages(PAGES);
    for (const hash of ["#/plugins/acme/nope", "#/plugins/other/report", "#/plugins/acme", "#/plugins", "#/plugins/acme/report/extra", "#/plugins/acme/"]) {
      expect(ia.resolve("user", hash), hash).toMatchObject({ redirected: true, hash: "#/runs", reason: "unknown" });
      expect(ia.resolve("admin", hash), hash).toMatchObject({ redirected: true, hash: "#/home" });
      expect(ia.resolve("user", hash).page.nav).not.toBe("plugin");
    }
  });

  it("finds nothing without plugins, and a reset removes the pages", () => {
    expect(ia.resolve("user", "#/plugins/acme/report")).toMatchObject({ redirected: true });
    ia.setPluginPages(PAGES);
    ia.setPluginPages([]);
    expect(ia.resolve("admin", "#/plugins/acme/report")).toMatchObject({ redirected: true });
    ia.setPluginPages(undefined);
    ia.setPluginPages("x");
  });

  it("drops entries that are not valid", () => {
    ia.setPluginPages([null, { plugin: "A", id: "x", title: "T", module: "/plugins/a/x.js" }, { plugin: "a", id: "x", title: "", module: "/plugins/a/x.js" }, { plugin: "a", id: "x", title: "T", module: "https://evil/x.js" }, { plugin: "a", id: "../x", title: "T", module: "/plugins/a/x.js" }, { plugin: "a", id: "ok", title: "T", module: "/plugins/a/x.js" }]);
    expect(ia.resolve("user", "#/plugins/a/ok").redirected).toBe(false);
    expect(ia.resolve("user", "#/plugins/a/x").redirected).toBe(true);
  });

  it("is a user-display address only for a plugin address shape", () => {
    expect(auth.isUserHash("#/plugins/acme/report")).toBe(true);
    expect(auth.userPage("#/plugins/acme/report")).toMatchObject({ section: "plugins", id: "acme" });
    for (const bad of ["#/plugins", "#/plugins/acme", "#/plugins/Acme/report", "#/plugins/acme/report/x", "#/plugins/a_b/c"]) expect(auth.isUserHash(bad), bad).toBe(false);
  });
});

describe("the plugin menu", () => {
  const side = () => new FakeElement("nav");

  it("adds a Plugins heading and one link per item, for pages that are registered", () => {
    ia.setPluginPages(PAGES);
    const nav = side();
    plugins.addPluginMenu([{ plugin: "acme", page: "report", label: "Report" }, { plugin: "acme", page: "gone", label: "Gone" }, { plugin: "acme", page: "secret", label: "" }], { side: nav });
    const links = nav.all("a");
    expect(links.map((a) => [a.attrs.href, a.attrs["data-nav"], a.textContent])).toEqual([["#/plugins/acme/report", "plugin-acme-report", "Report"]]);
    expect(nav.all("span").map((s) => s.textContent)).toEqual(["Plugins"]);
    expect(audit(nav)).toEqual([]);
  });

  it("adds nothing without items, and replaces its own earlier items", () => {
    ia.setPluginPages(PAGES);
    const nav = side();
    plugins.addPluginMenu([], { side: nav });
    expect(nav.children).toEqual([]);
    plugins.addPluginMenu([{ plugin: "acme", page: "report", label: "Report" }], { side: nav });
    plugins.addPluginMenu([{ plugin: "acme", page: "secret", label: "Secret" }], { side: nav });
    expect(nav.all("a").map((a) => a.textContent)).toEqual(["Secret"]);
    expect(nav.all("span")).toHaveLength(1);
    plugins.addPluginMenu(undefined, { side: nav });
    expect(nav.children).toEqual([]);
    expect(() => plugins.addPluginMenu([{ plugin: "acme", page: "report", label: "R" }], { side: null })).not.toThrow();
  });

  it("loads the pages from the server answer, and survives a failure", async () => {
    const r = await plugins.loadPluginUi({ load: async () => ({ pages: PAGES, menu: [{ plugin: "acme", page: "report", label: "Report" }] }) });
    expect(r.menu).toHaveLength(1);
    expect(ia.resolve("user", "#/plugins/acme/report").redirected).toBe(false);
    const failed = await plugins.loadPluginUi({ load: async () => { throw new Error("down"); } });
    expect(failed).toEqual({ menu: [] });
    expect(ia.resolve("user", "#/plugins/acme/report").redirected).toBe(true);
    expect(await plugins.loadPluginUi({ load: async () => ({}) })).toEqual({ menu: [] });
  });
});

describe("renderPluginPage", () => {
  const page = { plugin: "acme", title: "Report", module: "/plugins/acme/report.js" };
  const user = { id: "u1", name: "Ann", role: "user", email: "ann@example.com" };

  it("calls render(box, ctx) with the kit and the person, and draws with the kit without accessibility problems", async () => {
    const box = new FakeElement("div");
    let seen: any;
    let cleaned = "";
    const done = await plugins.renderPluginPage(box, page, {
      user, readOnly: true,
      load: async (url: string) => ({
        render(el: FakeElement, ctx: any) {
          seen = ctx;
          const { actions, display, forms } = ctx.kit;
          ctx.mount(el, ctx.h("h2", {}, "Report"), display.card({ title: "Rows" }, forms.field({ label: "Name" }, forms.textInput({}))), actions.button({ label: "Go" }, "Go"));
          return () => void (cleaned = url);
        },
      }),
    });
    expect(Object.keys(seen.kit).sort()).toEqual(["actions", "display", "forms", "overlays", "records"]);
    expect(seen).toMatchObject({ role: "user", readOnly: true, plugin: "acme", user: { id: "u1", name: "Ann", role: "user" } });
    expect(seen.user).not.toHaveProperty("email");
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.user)).toBe(true);
    expect(typeof seen.h).toBe("function");
    expect(typeof seen.mount).toBe("function");
    expect(audit(box)).toEqual([]);
    done();
    expect(cleaned).toBe("/plugins/acme/report.js");
  });

  it("gives no cleanup when the page returns none", async () => {
    expect(await plugins.renderPluginPage(new FakeElement("div"), page, { user, load: async () => ({ render: () => 5 }) })).toBeUndefined();
  });

  it("throws a plain message when the module has no render, or cannot be loaded", async () => {
    await expect(plugins.renderPluginPage(new FakeElement("div"), page, { user, load: async () => ({}) })).rejects.toThrow(/has no render\(box, ctx\) function/);
    await expect(plugins.renderPluginPage(new FakeElement("div"), page, { user, load: async () => { throw new Error("secret /path"); } })).rejects.toThrow(/^The page "Report" of the plugin "acme" could not be loaded\.$/);
  });

  it("never imports a module for an address that resolves to the fallback", async () => {
    const calls: string[] = [];
    const load = async (u: string) => (calls.push(u), { render() {} });
    // the same decision as ui/user/app.js and ui/app.js: only a resolved page with nav "plugin" is drawn by a plugin
    const draw = async (role: string, hash: string) => {
      const to = ia.resolve(role, hash);
      if (to.page.nav === "plugin") await plugins.renderPluginPage(new FakeElement("div"), to.page, { user, load });
      return to;
    };
    expect((await draw("user", "#/plugins/acme/report")).redirected).toBe(true); // nothing registered for this account
    ia.setPluginPages([PAGES[0]]); // what the server listed for a user
    expect((await draw("user", "#/plugins/acme/secret")).page.nav).not.toBe("plugin"); // an admin-only page is not listed
    expect((await draw("user", "#/plugins/acme/nope")).page.id).toBe("runs");
    expect(calls).toEqual([]);
    await draw("user", "#/plugins/acme/report");
    expect(calls).toEqual(["/plugins/acme/report.js"]);
  });
});

describe("the settings cards of plugins", () => {
  const field = (key: string, kind: string, extra: object = {}) => ({ key: `plugin_settings.acme.${key}`, kind, label: key, help: "Help.", default: undefined, optional: true, effect: "now", effectText: "at once", control: "generated", ...extra });
  const sections = [{
    plugin: "acme", title: "Acme",
    fields: [field("limit", "number", { integer: true, min: 0, max: 10, default: 5, optional: false }), field("verbose", "yes-no", { default: true, optional: false }), field("heading", "text"), field("zero", "number", { integer: true, default: 3, optional: false })],
    values: { limit: 5, verbose: true, zero: 3 },
  }];
  const build = (stored: object | undefined, ...rest: any[]) => plugins.pluginSettingCards({ plugin_settings: stored }, rest.length ? rest[0] : sections, { section });
  const checkbox = (cards: any) => cards.cards[0].all("input").find((i: FakeElement) => i.attrs.type === "checkbox");

  it("starts from the effective values: a default true is checked", () => {
    const cards = build(undefined);
    expect(cards.active).toBe(true);
    expect(cards.cards).toHaveLength(1);
    expect(checkbox(cards).checked).toBe(true);
    expect(cards.cards[0].all("input").find((i: FakeElement) => i.attrs.type === "number").value).toBe("5");
    expect(audit(cards.cards[0])).toEqual([]);
  });

  it("saves nothing for untouched defaults, and keeps an explicit false or 0", () => {
    expect(build(undefined).value()).toEqual({});
    const kept = build({ acme: { verbose: false, zero: 0 } }, [{ ...sections[0], values: { limit: 5, verbose: false, zero: 0 } }]);
    expect(checkbox(kept).checked).toBe(false);
    expect(kept.value()).toEqual({ acme: { verbose: false, zero: 0 } });
  });

  it("saves a changed value, and the saved value reads back the same", () => {
    const cards = build(undefined);
    const box = checkbox(cards);
    box.checked = false;
    box.fire("change", { target: box });
    expect(cards.value()).toEqual({ acme: { verbose: false } });
    const reloaded = build({ acme: { verbose: false } }, [{ ...sections[0], values: { limit: 5, verbose: false, zero: 3 } }]);
    expect(checkbox(reloaded).checked).toBe(false);
    expect(reloaded.value()).toEqual({ acme: { verbose: false } });
  });

  it("keeps the section of a plugin that is not loaded, and drops a stored key the plugin no longer has", () => {
    const cards = build({ gone: { a: 1 }, acme: { old: 1, limit: 4 } }, [{ ...sections[0], values: { limit: 4, verbose: true, zero: 3 } }]);
    expect(cards.value()).toEqual({ gone: { a: 1 }, acme: { limit: 4 } });
  });

  it("has no card and does not save anything without sections", () => {
    for (const none of [undefined, [], null]) {
      const cards = build({ gone: { a: 1 } }, none);
      expect(cards).toMatchObject({ active: false, cards: [] });
      expect(cards.check()).toBeUndefined();
      expect(cards.inputs()).toEqual({});
    }
  });
});
