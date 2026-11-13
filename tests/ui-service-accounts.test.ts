import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The "Service accounts" section of the Users page (#866): the list, the add dialog, the token shown once, rotate and revoke.
let restore: () => void;
let ui: any;
let users: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/service-accounts.js" as string);
  users = await import("../ui/users.js" as string);
});
afterAll(() => restore());

const TOKEN = "scf_svc_" + "Ab3_".repeat(10) + "xyz";
const GRANTABLE = [
  { key: "GET runs", note: "list runs", adminOnly: false },
  { key: "GET health", note: "server health", adminOnly: true },
];
const account = (over: object = {}) => ({
  id: "s1", name: "Robot", status: "active", scope: ["GET runs"], created: "2026-01-01T00:00:00.000Z", lastUse: null, token: "live", expires: "2026-02-01T00:00:00.000Z", runs: 0, ...over,
});
let accounts: any[];
let sent: { method: string; url: string; body: any }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  accounts = [account(), account({ id: "s2", name: "Old", token: "expired", lastUse: new Date().toISOString(), scope: [] })];
  sent = [];
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).getElementById("main").replaceChildren();
  (document as any).listeners.keydown = [];
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") return reply({ accounts, grantable: GRANTABLE });
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    if (init.method === "POST" && url === "/api/service-accounts") return reply({ account: account({ id: "new", name: body.name, scope: body.scope }), token: TOKEN }, 201);
    if (url.endsWith("/rotate")) return reply({ account: account(), token: TOKEN });
    return reply({ account: account(), ok: true });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const press = async (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
  await flush();
  await flush();
};
const rows = () => main().all("tr").filter((r) => r.all("td").length);
const show = async (opts: object = {}) => {
  const box = (document as any).createElement("div");
  main().append(box);
  await ui.renderServiceAccounts(box, { clipboard: () => ({ writeText: async () => {} }), ...opts });
  return box as FakeElement;
};

describe("pure helpers", () => {
  it("says the token state and the last use in words", () => {
    expect(ui.tokenText({ token: "live" })).toBe("live");
    expect(ui.tokenText({ token: "revoked" })).toBe("revoked");
    expect(ui.tokenText({ token: "expired" })).toContain("expired");
    expect(ui.lastUseText({ lastUse: null })).toBe("never");
    expect(ui.lastUseText({ lastUse: new Date().toISOString() })).toBe("just now");
  });
  it("sends only the checked keys, trimmed name", () => {
    expect(ui.scopeBody({ name: "  Bot ", checked: new Set(["GET health"]) }, GRANTABLE)).toEqual({ name: "Bot", scope: ["GET health"] });
    expect(ui.scopeBody({ name: "x", checked: new Set() }, GRANTABLE)).toEqual({ name: "x", scope: [] });
  });
});

describe("the section", () => {
  it("lists name, status, token state, last use and scope", async () => {
    const box = await show();
    expect(box.textContent).toContain("Service accounts");
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r[0]!.textContent).toContain("Robot");
    expect(r[0]!.textContent).toContain("live");
    expect(r[0]!.textContent).toContain("never");
    expect(r[0]!.textContent).toContain("GET runs");
    expect(r[1]!.textContent).toContain("expired");
    expect(r[1]!.textContent).toContain("none");
  });

  it("has no buttons when it is read only", async () => {
    const box = await show({ readOnly: true });
    expect(walk(box).some((e) => e.tag === "button")).toBe(false);
  });

  it("adds an account with the checked routes only, and shows the token once", async () => {
    const box = await show();
    await press(button(box, "+ Add service account"));
    const dialog = root();
    const name = walk(dialog).find((e) => e.attrs.name === "name")!;
    name.value = " Bot ";
    const boxes = walk(dialog).filter((e) => e.attrs.name === "scope");
    expect(boxes.map((b) => b.value)).toEqual(["GET runs", "GET health"]);
    expect(dialog.textContent).toContain("admin only");
    boxes[1]!.checked = true;
    boxes[1]!.click(); // a browser sets `checked` and then sends the click
    await press(button(dialog, "Add"));
    expect(sent[0]).toEqual({ method: "POST", url: "/api/service-accounts", body: { name: "Bot", scope: ["GET health"] } });
    const shown = walk(root()).find((e) => e.attrs.name === "token")!;
    expect(shown.attrs.value ?? (shown as any).value).toBe(TOKEN);
    expect(root().textContent).toContain("Shown once");
    await press(button(root(), "Done"));
    expect(root().children.length).toBe(0);
  });

  it("rotates and revokes with the right calls", async () => {
    const box = await show();
    await press(button(rows()[0]!, "Rotate"));
    expect(sent[0]).toMatchObject({ method: "POST", url: "/api/service-accounts/s1/rotate" });
    expect(walk(root()).find((e) => e.attrs.name === "token")).toBeDefined();
    await press(button(root(), "Done"));
    await press(button(rows()[0]!, "Revoke"));
    await press(button(root(), "Revoke"));
    expect(sent[1]).toMatchObject({ method: "POST", url: "/api/service-accounts/s1/revoke" });
    await press(button(rows()[0]!, "Delete"));
    await press(button(root(), "Delete"));
    expect(sent[2]).toMatchObject({ method: "DELETE", url: "/api/users/s1" });
    expect(box).toBeDefined();
  });

  it("shows a failure inside the section and leaves the page alone", async () => {
    (globalThis as any).fetch = async () => ({ ok: false, status: 500, statusText: "x", json: async () => ({ error: "broken" }) });
    const box = await show();
    expect(box.textContent).toContain("could not be loaded");
  });

  it("is drawn by the Users page below the people, through the `services` option", async () => {
    const stopped: string[] = [];
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "x", json: async () => [] });
    await users.renderUsers(main(), { me: "me", data: [[], null], services: (b: FakeElement) => (b.append("section here"), () => stopped.push("stop")) });
    expect(main().textContent).toContain("section here");
  });
});
