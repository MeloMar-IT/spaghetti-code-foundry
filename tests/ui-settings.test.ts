import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { describeSettings, startupSettings } from "../src/settings/describe.js";
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
async function render(server: Record<string, unknown>, listening = "127.0.0.1", putStatus = 200, extra: Record<string, unknown> = {}, restart?: unknown) {
  const config = { ...ConfigSchema.parse({}), server: { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false, ...server }, ...extra };
  const puts: any[] = [];
  const restarts: string[] = [];
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (url.endsWith("/api/restart") && restart !== undefined) {
      restarts.push(init?.method ?? "GET");
      return { ok: true, status: 200, statusText: "OK", json: async () => restart };
    }
    if (init?.method === "PUT") {
      puts.push(JSON.parse(init.body!));
      return { ok: putStatus === 200, status: putStatus, statusText: "x", json: async () => (putStatus === 200 ? config : { error: "invalid config: nope" }) };
    }
    const body = url.endsWith("/api/info") ? { configPath: "/x/config.yaml", spentToday: 0, listening }
      : url.endsWith("/api/settings") ? (oldServer ? {} : { settings: describeSettings(), startup: startupSettings({ home: "/data", port: 4000, repo: "/repo", claudeBin: "claude", codexBin: "codex", ghBin: "gh" }) })
      : config;
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };
  const main = new FakeElement("main");
  offs.push(await ui.renderSettings(main));
  const cards = main.all("div").filter((d) => (d.attrs.class ?? "").split(" ").includes("card"));
  const card = cards.find((c) => c.all("h3")[0]?.textContent === "Network")!;
  return { main, card, puts, restarts };
}
let oldServer = false;
const offs: any[] = [];
afterEach(() => { for (const o of offs.splice(0)) o?.(); oldServer = false; });

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Settings page frame", () => {
  it("mounts one settings page: toolbar head, notices, sections", async () => {
    const { main } = await render({});
    expect(main.children).toHaveLength(1);
    const root = main.children[0] as FakeElement;
    expect(root.getAttribute("class")).toBe("page page-settings");
    expect(root.children.map((c) => (c as FakeElement).getAttribute("class"))).toEqual(["toolbar page-head", "page-notices", "page-sections"]);
  });
});

describe("Settings → Network", () => {
  it("shows the settings and the plain-HTTP warning", async () => {
    const { card } = await render({ listen: "::1", allowed_hosts: ["a.test", "b.test"], allow_insecure_http: true });
    expect(card).toBeDefined();
    expect(card.all("select")[0]!.value).toBe("::1");
    expect(card.all("input").find((i) => i.attrs.placeholder === "mymac.local")!.value).toBe("a.test, b.test");
    expect((card.all("input").find((i) => i.attrs.type === "checkbox") as any).checked).toBe(true);
    expect(card.textContent).toContain("passwords and session cookies cross the network unencrypted");
  });

  it("says nothing about a restart on a server without the restart route", async () => {
    const differ = await render({ listen: "0.0.0.0" }, "127.0.0.1");
    expect(differ.main.textContent).not.toContain("Now listening on");
    expect(differ.main.textContent).not.toContain("A restart is needed");
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

describe("Settings → Ask SCF", () => {
  const cardTitles = (main: FakeElement) => main.all("div").filter((d) => (d.attrs.class ?? "").split(" ").includes("card")).map((c) => c.all("h3")[0]?.textContent);
  const cardOf = (main: FakeElement, title: string) => main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === title)!;
  const stored = { enabled: false, sensitive_patterns: [" spaced ", "a\nb"], disabled_accounts: ["8f14e45f-ceea-467f-a0e6-1d2f9b5b5c11"], timeout_seconds: 60, max_parallel: 1, max_queued: 10, turns_per_user_per_day: 30, max_cost_usd_per_turn: 0.1 };

  it("sits between User runs and Notifications", async () => {
    const t = cardTitles((await render({})).main);
    expect(t.indexOf("Ask SCF")).toBe(t.indexOf("User runs") + 1);
    expect(t.indexOf("Delivery")).toBe(t.indexOf("Ask SCF") + 1);
    expect(t.indexOf("Notifications")).toBe(t.indexOf("Delivery") + 1);
  });

  it("saves the switch and a number and keeps the private patterns and accounts", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, { help: stored });
    const card = cardOf(main, "Ask SCF");
    const sw = card.all("input").find((i) => i.attrs.type === "checkbox") as any;
    sw.checked = true;
    sw.fire("change", { target: sw });
    const days = card.all("input").filter((i) => i.attrs.type === "number")[0] as any;
    days.value = "45";
    days.fire("change", { target: days });
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].help.sensitive_patterns).toEqual([" spaced ", "a\nb"]);
    expect(puts[0].help.disabled_accounts).toEqual(stored.disabled_accounts);
    expect(puts[0].help.enabled).toBe(true);
    expect(Object.values(puts[0].help)).toContain(45);
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(puts[0]))).success).toBe(true);
  });

  it("shows the hint of the redesign switch", async () => {
    const { main } = await render({});
    expect(cardOf(main, "Redesign").textContent).toContain("Takes effect at once.");
  });
});

describe("Settings → Delivery", () => {
  it("saves the switch and keeps the per-repository requirements", async () => {
    const repositories = { "acme/app": { provenance: true } };
    const { main, puts } = await render({}, "127.0.0.1", 200, { delivery: { ...ConfigSchema.parse({}).delivery, repositories } });
    const card = main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === "Delivery")!;
    const sw = card.all("input").find((i) => i.attrs.type === "checkbox") as any;
    sw.checked = true;
    sw.fire("change", { target: sw });
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].delivery.provenance).toBe(true);
    expect(puts[0].delivery.repositories).toEqual(repositories);
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(puts[0]))).success).toBe(true);
  });
});

describe("Settings → Policy", () => {
  it("saves the enforced rules and keeps the pack lists", async () => {
    const policy = { ...ConfigSchema.parse({}).policy, packs: ["org"], enforce: ["path-forbidden"] };
    const { main, puts } = await render({}, "127.0.0.1", 200, { policy });
    const titles = main.all("div").filter((d) => (d.attrs.class ?? "").split(" ").includes("card")).map((c) => c.all("h3")[0]?.textContent);
    expect(titles).toContain("Policy");
    expect(titles.indexOf("Policy")).toBeGreaterThan(titles.indexOf("GitHub App"));
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].policy.packs).toEqual(["org"]);
    expect(puts[0].policy.enforce).toEqual(["path-forbidden"]);
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(puts[0]))).success).toBe(true);
  });
});

describe("Settings → Load governor", () => {
  const card = (main: FakeElement) => main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === "Load governor")!;

  it("follows Budget & capacity and shows low", async () => {
    const { main } = await render({});
    const titles = main.all("div").filter((d) => (d.attrs.class ?? "").split(" ").includes("card")).map((c) => c.all("h3")[0]?.textContent);
    expect(titles.indexOf("Load governor")).toBe(titles.indexOf("Budget & capacity") + 1);
    expect(card(main).all("select")).toHaveLength(1);
    expect(card(main).textContent).toContain("Default: low.");
  });

  it("saves the choice", async () => {
    const { main, puts } = await render({});
    const sel = card(main).all("select")[0] as any;
    sel.value = "background";
    sel.fire("change", { target: sel });
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].governor).toEqual({ priority: "background" });
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(puts[0]))).success).toBe(true);
  });

  const floorInput = (main: FakeElement) => card(main).all("input").filter((i) => i.attrs.type === "number")[0] as any;

  it("has one number input for the lowest runs, empty when not set", async () => {
    const { main } = await render({});
    expect(card(main).all("input").filter((i) => i.attrs.type === "number")).toHaveLength(1);
    expect(floorInput(main).value ?? "").toBe("");
  });

  it("saves a floor of 0 as 0, shows a stored 0, and drops the key when it is emptied", async () => {
    const first = await render({});
    const input = floorInput(first.main);
    input.value = "0";
    input.fire("change", { target: input });
    first.main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(first.puts[0].governor.floor).toBe(0);
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(first.puts[0]))).data?.governor.floor).toBe(0);

    const stored = await render({}, "127.0.0.1", 200, { governor: { priority: "low", floor: 0 } });
    expect(String(floorInput(stored.main).value)).toBe("0");
    const again = floorInput(stored.main);
    again.value = "";
    again.fire("change", { target: again });
    stored.main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect("floor" in stored.puts[0].governor).toBe(false);
  });
});

describe("Settings → Promotion gate", () => {
  const card = (main: FakeElement) => main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === "Promotion gate")!;
  const numbers = (main: FakeElement) => card(main).all("input").filter((i) => i.attrs.type === "number");

  it("has a card with the four settings", async () => {
    const { main } = await render({});
    expect(card(main)).toBeDefined();
    expect(numbers(main)).toHaveLength(4);
  });

  it("keeps the stored thresholds when the page is saved", async () => {
    const governance = { promotion: { min_runs: 25, evidence_completeness: 0.8, eval_pass_rate: 0.7, within_days: 60 } };
    const { main, puts } = await render({}, "127.0.0.1", 200, { governance });
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].governance).toEqual(governance);
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(puts[0]))).success).toBe(true);
  });

  it("saves the defaults when nothing was stored", async () => {
    const { main, puts } = await render({});
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].governance).toEqual({ auto_demote: true, promotion: { min_runs: 10, evidence_completeness: 0.95, eval_pass_rate: 0.9, within_days: 30 } });
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

  it("links to the repositories that use the app", async () => {
    const { main } = await render({});
    const link = appCard(main).all("a").find((a) => a.textContent === "Repositories that use the app")!;
    expect(link.attrs.href).toBe("#/all-repos?method=github-app");
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

describe("read-only Settings", () => {
  it("shows the values without a Save button or any control that changes", async () => {
    const { main, puts } = await render({});
    expect(main.all("button").map((b) => b.textContent)).toContain("Save");
    expect(main.all("input").some((i: any) => i.readOnly)).toBe(false);
    const ro = new FakeElement("main");
    await ui.renderSettings(ro, { readOnly: true });
    expect(ro.all("button")).toHaveLength(0);
    expect(ro.all("span").some((s) => s.getAttribute("role") === "status")).toBe(false);
    expect(ro.all("fieldset")).toHaveLength(0);
    for (const i of ro.all("input") as any[]) {
      if (i.attrs.type === "checkbox") expect(i.disabled).toBe(true);
      else expect(i.readOnly).toBe(true);
    }
    for (const s of ro.all("select") as any[]) expect(s.disabled).toBe(true);
    expect((ro.all("label").find((l) => l.textContent.includes("Keep the audit log"))!.all("input")[0] as any).value).toBe("180");
    expect(puts).toHaveLength(0);
  });
});

describe("Settings → Agents and User runs", () => {
  const cardOf = (main: FakeElement, title: string) => main.all("div").find((d) => (d.attrs.class ?? "").split(" ").includes("card") && d.all("h3")[0]?.textContent === title)!;
  const area = (main: FakeElement, label: string) => main.all("div").find((d) => d.attrs.class?.startsWith("scf-field") && d.all("label")[0]?.textContent === label)!.all("textarea")[0] as any;
  const change = (el: any, value: string) => {
    el.value = value;
    el.fire("change", { target: el });
  };
  const save = async (main: FakeElement) => {
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
  };
  const alertsOf = (el: FakeElement) => el.all("div").filter((d) => d.attrs.role === "alert");

  it("shows the switches as configured, the model, and the hints from the description", async () => {
    const { main } = await render({}, "127.0.0.1", 200, { isolate_agents: false });
    const agents = cardOf(main, "Agents");
    const boxes = agents.all("input").filter((i) => i.attrs.type === "checkbox") as any[];
    expect(boxes).toHaveLength(2);
    expect(!!boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    expect((agents.all("input").find((i) => i.attrs.type === "text") as any).value).toBe("haiku");
    expect(agents.textContent).toContain("Default: yes.");
    expect(agents.textContent).toContain("Takes effect when a run starts or resumes.");
    const runs = cardOf(main, "User runs");
    expect(runs.all("textarea")).toHaveLength(3);
    expect(runs.textContent).toContain("At most 50 items.");
    expect(runs.textContent).toContain("At most 100 items.");
  });

  it("saves the new settings and keeps the others of the sandbox", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, { sandbox: { docker_image: "node:22", user_runs: "off", user_read: [] } });
    const agents = cardOf(main, "Agents");
    const model = agents.all("input").find((i) => i.attrs.type === "text") as any;
    change(model, " ollama:qwen ");
    const sw = agents.all("input").find((i) => i.attrs.type === "checkbox") as any;
    sw.checked = false;
    sw.fire("change", { target: sw });
    change(area(main, "Variables for all steps"), "HTTPS_PROXY\nAWS_*");
    change(area(main, "Variables for agent steps"), "OPENAI_API_KEY");
    change(area(main, "Extra readable paths"), "/opt/node");
    await save(main);
    expect(puts).toHaveLength(1);
    expect(puts[0].isolate_agents).toBe(false);
    expect(puts[0].failure_summary).toEqual({ enabled: true, model: "ollama:qwen" });
    expect(puts[0].step_env).toEqual({ pass: ["HTTPS_PROXY", "AWS_*"], agent_pass: ["OPENAI_API_KEY"] });
    expect(puts[0].sandbox).toEqual({ docker_image: "node:22", user_runs: "off", user_read: ["/opt/node"] });
    expect(ConfigSchema.safeParse(JSON.parse(JSON.stringify(puts[0]))).success).toBe(true);
  });

  it("saves the default model for an empty one", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, { failure_summary: { enabled: true, model: "sonnet" } });
    change(cardOf(main, "Agents").all("input").find((i) => i.attrs.type === "text"), "  ");
    await save(main);
    expect(puts[0].failure_summary.model).toBe("haiku");
  });

  it.each([
    ["Variables for all steps", "GH_TOKEN", "GH_TOKEN"],
    ["Variables for agent steps", "1BAD", "1BAD"],
    ["Extra readable paths", "rel/path", "rel/path"],
  ])("refuses %s with %s at the field and sends nothing", async (label, value, named) => {
    const { main, puts } = await render({});
    change(area(main, label), value);
    await save(main);
    expect(puts).toHaveLength(0);
    expect(main.all("span").find((s) => s.getAttribute("role") === "status")!.textContent).toBe("Not saved.");
    const shown = area(main, label);
    expect(alertsOf(shown.parent).map((a) => a.textContent).join("")).toContain(named);
    expect(shown.attrs["aria-invalid"]).toBe("true");
    expect((globalThis as any).document.activeElement).toBe(shown);
  });

  it("refuses more than 100 names", async () => {
    const { main, puts } = await render({});
    change(area(main, "Variables for agent steps"), Array.from({ length: 101 }, (_, i) => `V_${i}`).join("\n"));
    await save(main);
    expect(puts).toHaveLength(0);
    expect(alertsOf(area(main, "Variables for agent steps").parent).map((a) => a.textContent).join("")).toContain("At most 100 items; this list has 101.");
  });

  it("marks the list that a server sentence names", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 400);
    await save(main);
    expect(puts).toHaveLength(1);
    const body = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => (init?.method === "PUT"
      ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: 'invalid config: step_env "pass" is refused' }) }
      : body(url, init));
    await save(main);
    expect(area(main, "Variables for all steps").attrs["aria-invalid"]).toBe("true");
  });

  it("shows every existing control with its default and when it takes effect", async () => {
    const { main } = await render({});
    const cards = (t: string) => cardOf(main, t).textContent;
    expect(cards("Budget & capacity")).toContain("Default: 2.");
    expect(cards("Budget & capacity")).toContain("Takes effect at once.");
    expect(cards("Network")).toContain("Takes effect after a restart.");
    const secrets = main.all("label").find((l) => l.textContent.includes("Block pushes that add secrets"))!.parent!;
    expect(secrets.textContent).toContain("Default: yes.");
    expect(cards("Safety")).toContain("Takes effect when a run starts or resumes.");
  });

  it("lists the start-up settings read-only", async () => {
    const { main } = await render({});
    const card = cardOf(main, "Set at start-up");
    expect(card.textContent).toContain("Data folder: /data");
    expect(card.textContent).toContain("Port: 4000");
    expect(card.textContent).toContain("Takes effect after a restart.");
    expect(card.all("input")).toHaveLength(0);
    expect(card.all("textarea")).toHaveLength(0);
    expect(card.all("button")).toHaveLength(0);
  });

  it("is read-only for a view-as session, including the new controls", async () => {
    await render({});
    const ro = new FakeElement("main");
    await ui.renderSettings(ro, { readOnly: true });
    expect(ro.all("button")).toHaveLength(0);
    for (const t of ro.all("textarea") as any[]) expect(t.readOnly).toBe(true);
    for (const i of ro.all("input") as any[]) expect(i.attrs.type === "checkbox" ? i.disabled : i.readOnly).toBe(true);
    // a refused value shown later keeps the lock
    const t = ro.all("textarea")[0] as any;
    t.value = "GH_TOKEN";
    t.fire("change", { target: t });
    expect((ro.all("textarea")[0] as any).readOnly).toBe(true);
  });
});

describe("Settings → Slack webhook", () => {
  const withHook = (set: boolean) => ({ notify: { ...ConfigSchema.parse({}).notify, slack_webhook_set: set } });
  const save = async (main: FakeElement) => {
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
  };
  const slackInput = (main: FakeElement) => main.all("input").find((i) => (i.attrs.placeholder ?? "").startsWith("https://hooks.slack.com"))! as any;
  const removeBox = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("Remove the Slack webhook"))!.all("input")[0] as any;

  it("notifyFrom: empty keeps, empty with remove gives null, a typed value wins", () => {
    expect(ui.notifyFrom({ slack: "" }).slack_webhook).toBeUndefined();
    expect(ui.notifyFrom({ slack: " ", removeSlack: true }).slack_webhook).toBeNull();
    expect(ui.notifyFrom({ slack: " https://x.test/h ", removeSlack: true }).slack_webhook).toBe("https://x.test/h");
  });

  it("says set, shows an empty field and sends no webhook key when untouched", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, withHook(true));
    expect(main.textContent).toContain("Slack webhook: set");
    expect(slackInput(main).value).toBe("");
    await save(main);
    expect("slack_webhook" in puts[0].notify && puts[0].notify.slack_webhook !== undefined).toBe(false);
  });

  it("sends null when Remove is checked", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 200, withHook(true));
    removeBox(main).checked = true;
    await save(main);
    expect(puts[0].notify.slack_webhook).toBeNull();
  });

  it("says not set and disables Remove", async () => {
    const { main } = await render({}, "127.0.0.1", 200, withHook(false));
    expect(main.textContent).toContain("Slack webhook: not set");
    expect(removeBox(main).disabled).toBe(true);
  });

  it("shows the new state after a save", async () => {
    const { main } = await render({}, "127.0.0.1", 200, withHook(true));
    slackInput(main).value = "https://hooks.slack.com/services/x";
    await save(main);
    expect(slackInput(main).value).toBe("");
    expect(main.textContent).toContain("Slack webhook: set");
  });
});

describe("Settings → restart box", () => {
  const need = [{ key: "server.listen", label: "Listen on", running: "127.0.0.1", saved: "0.0.0.0" }];
  const buttons = (el: any) => (el ? el.all("button").map((b: FakeElement) => b.textContent) : []);

  it("offers the restart when the server can restart itself", () => {
    const hits: string[] = [];
    const box = ui.restartBox({ needed: need, canRestart: true }, { onRequest: () => hits.push("request") });
    expect(box.textContent).toContain("A restart is needed: Listen on 127.0.0.1 → 0.0.0.0.");
    expect(buttons(box)).toEqual(["Restart when no story is running"]);
    box.all("button")[0].click();
    expect(hits).toEqual(["request"]);
  });

  it("says how to restart by hand when it cannot", () => {
    const box = ui.restartBox({ needed: need, canRestart: false, manual: "Stop it and start it again." });
    expect(box.textContent).toContain("Stop it and start it again.");
    expect(buttons(box)).toEqual([]);
  });

  it("shows the wait, its reason and the active runs, and lets a settings wait be cancelled", () => {
    const hits: string[] = [];
    const view = { needed: need, canRestart: true, waiting: { why: "settings", since: "x", activeRuns: 2, cancellable: true } };
    const box = ui.restartBox(view, { onCancel: () => hits.push("cancel") });
    expect(box.textContent).toContain("waits to restart for a changed setting");
    expect(box.textContent).toContain("2 active runs");
    expect(buttons(box)).toEqual(["Cancel the restart"]);
    box.all("button")[0].click();
    expect(hits).toEqual(["cancel"]);
    expect(ui.restartBox({ ...view, waiting: { ...view.waiting, activeRuns: 0 } }, {}).textContent).toContain("restarts in a moment");
  });

  it("has no cancel for a new version, and no buttons when read-only", () => {
    const wait = { why: "new_version", since: "x", activeRuns: 1, cancellable: false };
    expect(buttons(ui.restartBox({ needed: [], canRestart: true, waiting: wait }, {}))).toEqual([]);
    expect(buttons(ui.restartBox({ needed: need, canRestart: true, waiting: { ...wait, why: "settings", cancellable: true } }, { readOnly: true }))).toEqual([]);
    expect(buttons(ui.restartBox({ needed: need, canRestart: true }, { readOnly: true }))).toEqual([]);
  });

  it("draws nothing for an answer that is not a restart view, or when nothing is needed", () => {
    expect(ui.restartBox({ concurrency: 2 }, {})).toBeNull();
    expect(ui.restartBox(undefined, {})).toBeNull();
    expect(ui.restartBox({ needed: [], canRestart: true }, {})).toBeNull();
  });

  it("is on the page, and the button posts the request", async () => {
    const { main, restarts } = await render({ listen: "0.0.0.0" }, "127.0.0.1", 200, {}, { needed: need, canRestart: true });
    expect(main.textContent).toContain("A restart is needed: Listen on 127.0.0.1 → 0.0.0.0.");
    main.all("button").find((b) => b.textContent === "Restart when no story is running")!.click();
    await flush();
    expect(restarts).toContain("POST");
  });
});

describe("Settings → Skills", () => {
  const modalRoot = () => document.getElementById("modal-root") as unknown as FakeElement;
  const labelled = (main: FakeElement, text: string) => {
    const id = main.all("label").find((l) => l.textContent.startsWith(text))!.attrs.for;
    return main.all("input").concat(main.all("select"), main.all("textarea")).find((c) => c.attrs.id === id)!;
  };
  const labelOf = (key: string) => describeSettings().find((d) => d.key === key)!.label;
  const repoBox = (main: FakeElement) => main.all("label").find((l) => l.textContent.startsWith(labelOf("skills.repository")))!.all("input")[0] as any;
  const change = (el: any) => el.fire("change", { target: el });
  const save = (main: FakeElement) => main.all("button").find((b) => b.textContent === "Save")!.click();
  const skillsOf = () => ConfigSchema.parse({}).skills as any;
  const saveNote = (main: FakeElement) => main.all("span").find((s) => (s.attrs.class ?? "").startsWith("status"))!;

  it("has the card right after Safety", async () => {
    const { main } = await render({});
    const titles = main.all("h3").map((x) => x.textContent);
    expect(titles[titles.indexOf("Safety") + 1]).toBe("Skills");
  });

  it("saves a non-risky change without a dialog and keeps releases and tools", async () => {
    const skills = skillsOf();
    skills.releases.approved = [{ catalogue: "core", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` }];
    skills.tools.network = true;
    const { main, puts } = await render({}, "127.0.0.1", 200, { skills });
    const input = labelled(main, labelOf("skills.selection.max_skills")) as any;
    input.value = "3";
    change(input);
    save(main);
    await flush();
    expect(modalRoot().children).toHaveLength(0);
    expect(puts).toHaveLength(1);
    expect(puts[0].skills.selection.max_skills).toBe(3);
    expect(puts[0].skills.releases.approved).toEqual(skills.releases.approved);
    expect(puts[0].skills.tools).toEqual(skills.tools);
  });

  const group = (main: FakeElement, key: string) => main.all("div").find((g) => g.attrs.role === "group" && g.all("span").some((s) => s.attrs.id === g.attrs["aria-labelledby"] && s.textContent === labelOf(key)))!;

  it("asks before turning network on", async () => {
    const { main, puts } = await render({});
    const box = main.all("label").find((l) => l.textContent.startsWith(labelOf("skills.tools.network")))!.all("input")[0] as any;
    box.checked = true;
    change(box);
    save(main);
    await flush();
    expect(modalRoot().textContent).toContain("Skills that ask for network access may pass the plan gate.");
    modalRoot().all("button").find((b) => b.textContent === "Save anyway")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].skills.tools.network).toBe(true);
  });

  it("saves approved releases edited as rows, trimmed", async () => {
    const { main, puts } = await render({});
    const g = group(main, "skills.releases.approved");
    g.all("button").find((b) => b.textContent === "Add a row")!.click();
    const values: Record<string, string> = { catalogue: " core ", version: "1.0.0 ", digest: ` sha256:${"b".repeat(64)}` };
    for (const [k, v] of Object.entries(values)) {
      const i = group(main, "skills.releases.approved").all("input").find((x) => x.attrs["aria-label"] === `Row 1, ${k}`)! as any;
      i.value = v;
      change(i);
    }
    save(main);
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].skills.releases.approved).toEqual([{ catalogue: "core", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` }]);
  });

  it("shows a release issue as Row N, field in the card, not as unplaced", async () => {
    const skills = skillsOf();
    skills.releases.approved = [{ catalogue: "core", version: "1.0.0", digest: "bad" }];
    const { main } = await render({}, "127.0.0.1", 200, { skills });
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => (init?.method === "PUT"
      ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: "invalid config: x", issues: [{ path: "skills.releases.approved.0.digest", message: "must be sha256: and 64 hex digits" }] }) }
      : real(url, init));
    save(main);
    await flush();
    expect(group(main, "skills.releases.approved").textContent).toContain("Row 1, digest: must be sha256: and 64 hex digits");
    expect(main.textContent).toContain("Not saved: see the messages in the Skills card.");
    (globalThis as any).fetch = real;
  });

  it("asks before a risky change: Cancel sends nothing, Save anyway sends once", async () => {
    const { main, puts } = await render({});
    const box = repoBox(main);
    box.checked = true;
    change(box);
    save(main);
    await flush();
    expect(modalRoot().textContent).toContain("anyone who can push to that repository decides what is in it");
    modalRoot().all("button").find((b) => b.textContent === "Cancel")!.click();
    await flush();
    expect(puts).toHaveLength(0);
    expect(saveNote(main).textContent).toBe("Not saved.");
    save(main);
    await flush();
    modalRoot().all("button").find((b) => b.textContent === "Save anyway")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].skills.repository).toBe(true);
    save(main);
    await flush();
    expect(modalRoot().children).toHaveLength(0);
    expect(puts).toHaveLength(2);
  });

  it("does not ask for a value that was already risky", async () => {
    const skills = skillsOf();
    skills.repository = true;
    const { main, puts } = await render({}, "127.0.0.1", 200, { skills });
    save(main);
    await flush();
    expect(modalRoot().children).toHaveLength(0);
    expect(puts).toHaveLength(1);
  });

  it("shows the server's issues at their fields, then clears them on a save", async () => {
    const { main } = await render({});
    const real = (globalThis as any).fetch;
    const issues = [
      { path: "skills.selection.include.0", message: '"x" is also in exclude' },
      { path: "skills.catalogue.include", message: "more pinned skills than max_candidates" },
      { path: "skills.roots.1", message: "personal agent folders are never scanned" },
    ];
    (globalThis as any).fetch = async (url: string, init?: any) => (init?.method === "PUT"
      ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: 'invalid config: [{"message":"name"}]', issues }) }
      : real(url, init));
    save(main);
    await flush();
    const inField = (key: string) => labelled(main, labelOf(key)).parent!.textContent;
    expect(inField("skills.selection.include")).toContain('"x" is also in exclude');
    expect(inField("skills.catalogue.include")).toContain("more pinned skills than max_candidates");
    expect(inField("skills.roots")).toContain("Line 2: personal agent folders are never scanned");
    expect(main.textContent).toContain("Not saved: see the messages in the Skills card.");
    expect(main.all("input").concat(main.all("select")).filter((c) => c.attrs["aria-invalid"] === "true" && !String(c.attrs.id ?? "").startsWith("scf-field"))).toHaveLength(0);
    (globalThis as any).fetch = real;
    save(main);
    await flush();
    const card = main.all("h3").find((h3) => h3.textContent === "Skills")!.parent!;
    expect(card.all("div").filter((d) => d.attrs.role === "alert")).toHaveLength(0);
    expect(main.textContent).not.toContain("Not saved: see the messages");
  });

  it("keeps the whole error in the banner and marks the control when an issue is not at the card", async () => {
    const { main } = await render({});
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => (init?.method === "PUT"
      ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: "invalid config: BANNER-TEXT", issues: [
        { path: "skills.roots.0", message: "bad folder" },
        { path: "concurrency", message: "concurrency is too low" },
      ] }) }
      : real(url, init));
    save(main);
    await flush();
    expect(labelled(main, labelOf("skills.roots")).parent!.textContent).toContain("Line 1: bad folder");
    expect(main.textContent).toContain("BANNER-TEXT");
    expect(main.all("input").some((i) => i.attrs["aria-invalid"] === "true" && i.attrs.type === "number")).toBe(true);
  });

  it("marks the control a structured path names, also for a key the sentence does not quote", async () => {
    const { main } = await render({});
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => (init?.method === "PUT"
      ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: "invalid config: BANNER-TEXT", issues: [
        { path: "skills.roots.0", message: "bad folder" },
        { path: "self_update.repo", message: "Invalid string" },
      ] }) }
      : real(url, init));
    save(main);
    await flush();
    const repo = main.all("input").find((i) => i.attrs.placeholder === "owner/name")!;
    expect(repo.attrs["aria-invalid"]).toBe("true");
  });

  it("shows a message and keeps skills when the server cannot describe them", async () => {
    oldServer = true;
    const skills = skillsOf();
    const { main, puts } = await render({}, "127.0.0.1", 200, { skills });
    expect(main.textContent).toContain("The skills settings could not be described by the server.");
    save(main);
    await flush();
    expect(puts[0].skills).toEqual(skills);
  });
});
