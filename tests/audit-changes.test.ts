import { describe, expect, it } from "vitest";
import { AuditEntrySchema, DETAIL_MAX, auditActions, auditPath } from "../src/auth/audit.js";
import { MASKED_KEYS, changeDetail, configChanges, watcherChanges } from "../src/auth/audit-changes.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const valid = (detail: string) =>
  AuditEntrySchema.safeParse({ time: new Date().toISOString(), by: "cli", action: "settings-change", result: "ok", target: "config.yaml", detail }).success;

describe("audit changes", () => {
  it("names the masked keys in one place", () => expect([...MASKED_KEYS]).toEqual(["notify.slack_webhook", "notify.command", "agent_env"]));

  it("lists nested changes sorted, and nothing for equal input", () => {
    const a = { monitor: { stuck_run: { extra_minutes: 10 } }, concurrency: 1 };
    expect(configChanges(a, a)).toEqual([]);
    expect(configChanges(a, { monitor: { stuck_run: { extra_minutes: 20 } }, concurrency: 2 })).toEqual([
      { path: "concurrency", old: "1", new: "2" },
      { path: "monitor.stuck_run.extra_minutes", old: "10", new: "20" },
    ]);
  });

  it("never renders masked values, also for a removed object", () => {
    const r = configChanges({ notify: { slack_webhook: "SECRET-A", command: "SECRET-B", macos: true } }, {});
    expect(r).toEqual([{ path: "notify.command" }, { path: "notify.macos", old: "true", new: "(not set)" }, { path: "notify.slack_webhook" }]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(configChanges({ notify: {} }, { notify: { slack_webhook: "SECRET-A" } })).toEqual([{ path: "notify.slack_webhook" }]);
  });

  it("diffs config watchers by id and masks owner, task and agent_env", () => {
    const b = { watchers: [{ id: "w1", every: "5m", owner: "a@x", task: "T", vars: { agent_env: "S", test_cmd: "x" } }] };
    const a = { watchers: [{ id: "w1", every: "10m", owner: "b@x", task: "U", vars: { agent_env: "Z", test_cmd: "y" } }] };
    expect(configChanges(b, a)).toEqual([
      { path: "watchers.w1.every", old: '"5m"', new: '"10m"' },
      { path: "watchers.w1.owner" },
      { path: "watchers.w1.task" },
      { path: "watchers.w1.vars.agent_env" },
      { path: "watchers.w1.vars.test_cmd", old: '"x"', new: '"y"' },
    ]);
    const added = configChanges({}, a);
    expect(JSON.stringify(added)).not.toMatch(/"Z"|b@x/);
    expect(added.map((c) => c.path)).toContain("watchers.w1.id");
  });

  it("keeps watchers with the same id apart", () => {
    const one = { id: "dup", label: "one", owner: "o@x" };
    const two = { id: "dup", label: "two", every: "5m" };
    expect(configChanges({ watchers: [one, two] }, { watchers: [one, two] })).toEqual([]);
    const removed = configChanges({ watchers: [one, two] }, { watchers: [two] });
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((c) => c.path.startsWith("watchers.dup#1."))).toBe(true);
    expect(removed.find((c) => c.path.endsWith(".owner"))).toEqual({ path: "watchers.dup#1.owner" });
    expect(configChanges({ watchers: [one, two] }, { watchers: [one, { ...two, every: "9m" }] })).toEqual([{ path: "watchers.dup#2.every", old: '"5m"', new: '"9m"' }]);
  });

  it("watcherChanges masks agent_env and task", () => {
    const r = watcherChanges({ enabled: true, task: "a", vars: { agent_env: "S" } }, { enabled: false, task: "b", vars: { agent_env: "T" } });
    expect(r).toEqual([{ path: "enabled", old: "true", new: "false" }, { path: "task" }, { path: "vars.agent_env" }]);
  });

  it("escapes control characters in names and values", () => {
    const [c] = watcherChanges({}, { vars: { "a\nb": "x\u0085y" } });
    expect(c).toEqual({ path: "vars.a?b", old: "(not set)", new: '"x?y"' });
    expect(valid(changeDetail(c!))).toBe(true);
  });

  it("shows bot identity, arrays as leaves, unset and cut values", () => {
    expect(configChanges({ bot: { name: "a", email: "a@x" } }, { bot: { name: "b", email: "b@x" } }).map((c) => c.new)).toEqual(['"b@x"', '"b"']);
    expect(configChanges({ protected_branches: ["main"] }, { protected_branches: ["main", "rel/*"] })).toEqual([
      { path: "protected_branches", old: '["main"]', new: '["main","rel/*"]' },
    ]);
    expect(configChanges({}, { x: "a".repeat(300) })[0]!.new).toBe(`"${"a".repeat(79)}…`);
  });

  it("builds details that always pass the schema", () => {
    expect(changeDetail({ path: "a.b", old: "1", new: "2" })).toBe("a.b: 1 -> 2");
    expect(changeDetail({ path: "notify.command" })).toBe("notify.command: changed");
    expect(changeDetail({ path: "every", old: '"5m"', new: '"10m"' }, "watcher w: ")).toBe('watcher w: every: "5m" -> "10m"');
    const d = changeDetail({ path: "p", old: "1", new: "2" }, "x".repeat(DETAIL_MAX - 3) + " ");
    expect(d.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect(valid(d)).toBe(true);
  });

  it("keeps long names whole and the change itself, never cut", () => {
    const id = "w".repeat(500);
    const [c] = configChanges({ watchers: [{ id, enabled: true }] }, { watchers: [{ id, enabled: false }] });
    const d = changeDetail(c!);
    expect(d).toBe(`watchers.${id}.enabled: true -> false`);
    expect(valid(d)).toBe(true);
  });

  it("keeps very long names apart and keeps the change", () => {
    const common = "k".repeat(3000);
    const [a, b] = ["a", "b"].map((s) => changeDetail(watcherChanges({}, { vars: { [common + s]: "v" } })[0]!, "watcher w: "));
    expect(a).not.toBe(b);
    for (const d of [a!, b!]) {
      expect(d.length).toBeLessThanOrEqual(DETAIL_MAX);
      expect(d.endsWith(': (not set) -> "v"')).toBe(true);
      expect(valid(d)).toBe(true);
    }
  });
});

describe("auditActions", () => {
  it("skips a line the schema refuses, writes the others and logs once", () => {
    const saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "audit-actions-unit-"));
    try {
      const logs: string[] = [];
      auditActions((m) => logs.push(m), "cli", "settings-change", "config.yaml", ["a: 1 -> 2", "bad\nline", "b: 1 -> 2"]);
      const lines = existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean) : [];
      expect(lines.map((l) => JSON.parse(l).detail)).toEqual(["a: 1 -> 2", "b: 1 -> 2"]);
      expect(logs).toEqual(["audit: audit.jsonl not-valid (settings-change)"]);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = saved;
    }
  });
});
