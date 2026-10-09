import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin.js" as string);
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("serverFrom", () => {
  it("defaults the address", () => expect(ui.serverFrom({ listen: "" }).listen).toBe("127.0.0.1"));
  it("splits host names on commas and spaces", () => {
    expect(ui.serverFrom({ hosts: " a.test, b.test:8443  c.test " }).allowed_hosts).toEqual(["a.test", "b.test:8443", "c.test"]);
    expect(ui.serverFrom({ hosts: "" }).allowed_hosts).toEqual([]);
  });
  it("makes insecure a boolean", () => {
    expect(ui.serverFrom({ insecure: undefined }).allow_insecure_http).toBe(false);
    expect(ui.serverFrom({ insecure: true }).allow_insecure_http).toBe(true);
  });
});

/** Renders Settings against a stubbed API; returns the page and the PUT bodies. */
async function render(server: Record<string, unknown>, listening = "127.0.0.1", putStatus = 200, extra: Record<string, unknown> = {}) {
  const config = { ...ConfigSchema.parse({}), server: { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false, ...server }, ...extra };
  const puts: any[] = [];
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(init.body!));
      return { ok: putStatus === 200, status: putStatus, statusText: "x", json: async () => (putStatus === 200 ? config : { error: "invalid config: nope" }) };
    }
    const body = url.endsWith("/api/info") ? { configPath: "/x/config.yaml", spentToday: 0, listening } : config;
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };
  const main = new FakeElement("main");
  await ui.renderSettings(main);
  const cards = main.all("div").filter((d) => (d.attrs.class ?? "").split(" ").includes("card"));
  const card = cards.find((c) => c.all("h3")[0]?.textContent === "Network")!;
  return { main, card, puts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Settings → Network", () => {
  it("shows the settings and the plain-HTTP warning", async () => {
    const { card } = await render({ listen: "::1", allowed_hosts: ["a.test", "b.test"], allow_insecure_http: true });
    expect(card).toBeDefined();
    expect(card.all("select")[0]!.value).toBe("::1");
    expect(card.all("input").find((i) => i.attrs.placeholder === "mymac.local")!.value).toBe("a.test, b.test");
    expect((card.all("input").find((i) => i.attrs.type === "checkbox") as any).checked).toBe(true);
    expect(card.textContent).toContain("passwords and session cookies cross the network unencrypted");
  });

  it("says when a restart is needed", async () => {
    const differ = await render({ listen: "0.0.0.0" }, "127.0.0.1");
    expect(differ.card.textContent).toContain("Now listening on 127.0.0.1 — restart the server to use 0.0.0.0");
    const same = await render({ listen: "127.0.0.1" }, "127.0.0.1");
    expect(same.card.textContent).not.toContain("Now listening on");
  });

  it("saves the three controls and keeps the other settings", async () => {
    const { main, card, puts } = await render({});
    card.all("select")[0]!.value = "0.0.0.0";
    card.all("input").find((i) => i.attrs.placeholder === "mymac.local")!.value = "mymac.local";
    (card.all("input").find((i) => i.attrs.type === "checkbox") as any).checked = true;
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].server).toEqual({ listen: "0.0.0.0", allowed_hosts: ["mymac.local"], allow_insecure_http: true });
    expect(puts[0].concurrency).toBe(2);
    expect(puts[0].protected_branches).toContain("main");
  });

  it("shows the message of a failed save", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 400);
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(main.textContent).toContain("invalid config: nope");
  });
});

describe("Settings → Redesign", () => {
  const box = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("Show the redesigned pages (still being built)"))!.all("input")[0] as any;

  it("has the checkbox, off by default and on when the config says so", async () => {
    expect(!!box((await render({})).main).checked).toBe(false);
    expect(box((await render({}, "127.0.0.1", 200, { ui: { redesign: true } })).main).checked).toBe(true);
  });

  it("saves the choice and keeps the other settings", async () => {
    const { main, puts } = await render({});
    box(main).checked = true;
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].ui).toEqual({ redesign: true });
    expect(puts[0].concurrency).toBe(2);
  });
});

describe("Settings → no Disk section", () => {
  it("has no Disk card, Clean up or Preview button", async () => {
    const { main } = await render({});
    expect(main.all("h3").some((x) => x.textContent === "Disk")).toBe(false);
    expect(main.all("button").some((b) => ["Clean up", "Preview"].includes(b.textContent))).toBe(false);
  });

  it("saves with one PUT and never calls /api/clean", async () => {
    const { main, puts } = await render({});
    const calls: string[] = [];
    const inner = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      calls.push(url);
      return inner(url, init);
    };
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(calls.some((u) => u.includes("/api/clean"))).toBe(false);
  });
});

describe("Settings → GitHub App", () => {
  const appCard = (main: FakeElement) => main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === "GitHub App")!;
  const input = (card: FakeElement, label: string) => card.all("label").find((l) => l.textContent.startsWith(label))!.all("input")[0] as any;
  const save = async (main: FakeElement) => {
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
  };

  it("shows four fields with their hints", async () => {
    const { main } = await render({});
    const card = appCard(main);
    expect(card.all("input")).toHaveLength(4);
    for (const label of ["App ID", "App name (slug)", "Private key file", "Installation ID (optional)"]) expect(input(card, label), label).toBeDefined();
    expect(card.textContent).toContain("The last part of https://github.com/apps/<name>.");
    expect(card.textContent).toContain("Only for the bot identity: runs then commit and comment as the app.");
  });

  it("saves the slug and sends no installation id when it is empty", async () => {
    const { main, puts } = await render({});
    const card = appCard(main);
    input(card, "App ID").value = " 123 ";
    input(card, "App name (slug)").value = " my-app ";
    input(card, "Private key file").value = "/k/app.pem";
    await save(main);
    expect(puts[0].github_app).toEqual({ app_id: "123", private_key_path: "/k/app.pem", slug: "my-app", installation_id: undefined });
    expect(JSON.stringify(puts[0].github_app)).not.toContain("installation_id");
  });

  it("round-trips an old configuration unchanged", async () => {
    const old = { app_id: "1", installation_id: "2", private_key_path: "/k" };
    const { main, puts } = await render({}, "127.0.0.1", 200, { github_app: old });
    await save(main);
    expect(JSON.parse(JSON.stringify(puts[0].github_app))).toEqual(old);
    expect(ConfigSchema.parse(JSON.parse(JSON.stringify(puts[0]))).github_app).toEqual(old);
  });

  it("sends no github_app for an empty app id", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, { github_app: { app_id: "1", private_key_path: "/k", slug: "x" } });
    input(appCard(main), "App ID").value = "  ";
    await save(main);
    expect(puts[0].github_app).toBeUndefined();
  });
});

describe("Settings → Safety", () => {
  const hotfixBox = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("Hotfixes"))!.all("input")[0] as any;

  it("shows the hotfix switch unchecked and saves it when switched on", async () => {
    const { main, puts } = await render({});
    expect(!!hotfixBox(main).checked).toBe(false);
    hotfixBox(main).checked = true;
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].hotfix_to_main).toBe(true);
  });

  const sandboxBox = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("without the OS sandbox"))!.all("input")[0] as any;
  const save = async (main: FakeElement) => {
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
  };

  it("shows the OS sandbox box unchecked and saves 'off' when it is checked, keeping user_read and docker_image", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, { sandbox: { docker_image: "node:22", user_runs: "required", user_read: ["/opt/node"] } });
    expect(!!sandboxBox(main).checked).toBe(false);
    sandboxBox(main).checked = true;
    await save(main);
    expect(puts[0].sandbox).toEqual({ docker_image: "node:22", user_runs: "off", user_read: ["/opt/node"] });
  });

  it("saves 'required' when the box is unchecked", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, { sandbox: { user_runs: "off", user_read: [] } });
    expect(!!sandboxBox(main).checked).toBe(true);
    sandboxBox(main).checked = false;
    await save(main);
    expect(puts[0].sandbox.user_runs).toBe("required");
  });
});

describe("Settings → Safety: self-update", () => {
  const box = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("Self-update"))!.all("input")[0] as any;
  const repo = (main: FakeElement) => main.all("input").find((i) => i.attrs.placeholder === "owner/name") as any;

  it("is off and empty by default", async () => {
    const { main } = await render({});
    expect(!!box(main).checked).toBe(false);
    expect(repo(main).value).toBe("");
  });

  it("saves the switch and the trimmed repository", async () => {
    const { main, puts } = await render({});
    box(main).checked = true;
    repo(main).value = " acme/foundry ";
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].self_update).toEqual({ enabled: true, repo: "acme/foundry" });
  });
});

describe("Settings → Safety: audit log", () => {
  const field = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("Keep the audit log"))!.all("input")[0] as any;
  const save = async (main: FakeElement) => {
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
  };

  it("shows 180 by default, inside the Safety card", async () => {
    const { main } = await render({});
    expect(field(main).value).toBe("180");
    const safety = main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === "Safety")!;
    expect(safety.textContent).toContain("Keep the audit log for … days");
  });

  it("shows the configured value", async () => {
    const { main } = await render({}, "127.0.0.1", 200, { audit: { retention_days: 30 } });
    expect(field(main).value).toBe("30");
  });

  it("saves a typed value and keeps the other settings", async () => {
    const { main, puts } = await render({});
    field(main).value = "365";
    await save(main);
    expect(puts[0].audit).toEqual({ retention_days: 365 });
    expect(puts[0].concurrency).toBe(2);
  });

  it("saves 180 for an empty field and without a change", async () => {
    const empty = await render({});
    field(empty.main).value = "";
    await save(empty.main);
    expect(empty.puts[0].audit).toEqual({ retention_days: 180 });
    const same = await render({});
    await save(same.main);
    expect(same.puts[0].audit).toEqual({ retention_days: 180 });
  });

  it("sends an out-of-range value as typed and shows the server's message", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 400);
    field(main).value = "0";
    await save(main);
    expect(puts[0].audit.retention_days).toBe(0);
    expect(main.textContent).toContain("invalid config: nope");
  });
});
