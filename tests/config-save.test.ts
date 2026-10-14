import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { SEQ_WORK_LIMIT } from "../src/config-edit.js";
import { configVersion, editConfigText, parseConfigText, resetConfigText, saveConfig, type Config } from "../src/config.js";

/** Apply `change` to the parsed text and write the result in place. */
const edit = (text: string, change: (c: Record<string, any>) => void) => {
  const c = JSON.parse(JSON.stringify(parseConfigText(text))) as Record<string, any>;
  change(c);
  return editConfigText(text, c).text;
};

describe("editConfigText", () => {
  it("changes one key and nothing else", () => {
    const t = "# top\nconcurrency: 3 # mine\nprotected_branches:\n  - main\n";
    expect(edit(t, (c) => (c.concurrency = 4))).toBe("# top\nconcurrency: 4 # mine\nprotected_branches:\n  - main\n");
  });

  it("returns the same text for an unchanged body", () => {
    const t = "# top\nconcurrency:   3\n\n\nprotected_branches: [main]\n";
    expect(edit(t, () => {})).toBe(t);
  });

  it("keeps a default that the file states, when the body has the same value", () => {
    const t = "concurrency: 3\naudit:\n  retention_days: 180\n";
    expect(edit(t, (c) => (c.concurrency = 3))).toBe(t);
  });

  it("removes a key put back to its default, not its siblings", () => {
    const t = "concurrency: 3\n# keep\nprotected_branches:\n  - dev\nui:\n  redesign: true\n";
    const out = edit(t, (c) => (c.concurrency = parseConfigText("").concurrency));
    expect(out).toBe("# keep\nprotected_branches:\n  - dev\nui:\n  redesign: true\n");
  });

  it("keeps a key with an end-of-line comment when it goes back to its default", () => {
    const def = parseConfigText("").concurrency;
    const out = edit("concurrency: 3 # mine\n", (c) => (c.concurrency = def));
    expect(out).toContain(`concurrency: ${def} # mine`);
    expect(parseConfigText(out).concurrency).toBe(def);
  });

  it("removes an emptied parent", () => {
    expect(edit("audit:\n  retention_days: 30\n", (c) => (c.audit.retention_days = 180))).toBe("");
  });

  it("keeps a comment above a parent that is emptied", () => {
    const out = edit("concurrency: 3\n# about audit\naudit:\n  retention_days: 30\n", (c) => (c.audit.retention_days = 180));
    expect(out).toContain("# about audit");
    expect(parseConfigText(out).audit.retention_days).toBe(180);
    expect(parseConfigText(out).concurrency).toBe(3);
  });

  it("removes a key that the body leaves out", () => {
    const text = "concurrency: 3\nprotected_branches:\n  - dev\n";
    const out = editConfigText(text, { concurrency: 3 }).text;
    expect(out).toBe("concurrency: 3\n");
  });

  it("adds a nested key whose parent is not in the file", () => {
    const out = edit("concurrency: 3\n", (c) => (c.ui.redesign = true));
    expect(out).toBe("concurrency: 3\nui:\n  redesign: true\n");
  });

  const LIST = "# top\nwatchers:  # watchers\n  - id: a\n    github_repo: acme/app\n  # second\n  - id: b\n    github_repo: acme/web\n";

  it("edits one field of a list item and keeps the comments", () => {
    const out = edit(LIST, (c) => (c.watchers[0].github_repo = "acme/other"));
    expect(out).toContain("# watchers");
    expect(out).toContain("  # second\n  - id: b\n    github_repo: acme/web\n");
    expect(parseConfigText(out).watchers.map((w) => w.github_repo)).toEqual(["acme/other", "acme/web"]);
  });

  it("appends to a list and keeps the comments", () => {
    const out = edit(LIST, (c) => c.watchers.push({ ...c.watchers[0], id: "c" }));
    expect(out).toContain("# watchers");
    expect(out).toContain("# second");
    expect(parseConfigText(out).watchers.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("removes the first list item and keeps the comment of the next", () => {
    const out = edit(LIST, (c) => c.watchers.shift());
    expect(out).toContain("# second");
    expect(parseConfigText(out).watchers.map((w) => w.id)).toEqual(["b"]);
  });

  it("keeps the comments of untouched rules when the first changes and one is appended", () => {
    const t = "router:\n  rules:\n    - step: a\n      model: m1\n    # middle\n    - step: b\n      model: m2\n    - step: c # last\n      model: m3\n";
    const out = edit(t, (c) => {
      c.router.rules[0].model = "m9";
      c.router.rules.push({ step: "d", model: "m4" });
    });
    expect(out).toContain("# middle");
    expect(out).toContain("# last");
    expect(out).toContain("    - step: b\n      model: m2\n    - step: c # last\n      model: m3\n");
    expect(parseConfigText(out).router.rules.map((r) => r.model)).toEqual(["m9", "m2", "m3", "m4"]);
  });

  it("keeps the comment of a rule that moves", () => {
    const t = "router:\n  rules:\n    - step: a # first\n      model: m1\n    - step: b\n      model: m2\n    - step: c\n      model: m3\n";
    const out = edit(t, (c) => c.router.rules.unshift(c.router.rules.splice(1, 1)[0]));
    expect(out).toContain("- step: a # first");
    expect(parseConfigText(out).router.rules.map((r) => r.step)).toEqual(["b", "a", "c"]);
  });

  it("keeps an explicit default beside a sibling that goes back to its default", () => {
    const def = parseConfigText("").notify;
    const t = `notify:\n  macos: ${def.macos}\n  successes: ${!def.successes}\n`;
    const out = edit(t, (c) => (c.notify.successes = def.successes));
    expect(out).toBe(`notify:\n  macos: ${def.macos}\n`);
  });

  it("pairs watchers by id, so a comment inside one survives", () => {
    const t = "watchers:\n  - id: a\n    github_repo: acme/app\n  - id: b\n    github_repo: acme/web # web\n";
    const out = edit(t, (c) => {
      c.watchers.shift();
      c.watchers[0].every = "5m";
    });
    expect(out).toContain("# web");
    expect(parseConfigText(out).watchers).toHaveLength(1);
    expect(parseConfigText(out).watchers[0]!.every).toBe("5m");
  });

  it("keeps a comment above protected_branches when it grows", () => {
    const out = edit("# why\nprotected_branches:\n  - main\n", (c) => (c.protected_branches = ["main", "dev"]));
    expect(out).toContain("# why");
    expect(parseConfigText(out).protected_branches).toEqual(["main", "dev"]);
  });

  it("edits a record entry by entry", () => {
    const t = "providers:\n  y: # why y\n    kind: ollama\n";
    const added = edit(t, (c) => (c.providers.x = { kind: "ollama", base_url: "http://localhost:1/" }));
    expect(added).toContain("# why y");
    expect(added).toContain("x:");
    const changed = edit(added, (c) => (c.providers.x.base_url = "http://localhost:2/"));
    expect(changed).toContain("# why y");
    expect(changed).toContain("http://localhost:2/");
    const removed = edit(changed, (c) => delete c.providers.x);
    expect(removed).not.toContain("x:");
    expect(removed).toContain("# why y");
  });

  it("sets and unsets an optional key", () => {
    const set = edit("concurrency: 3\n", (c) => (c.default_model = "sonnet"));
    expect(set).toBe("concurrency: 3\ndefault_model: sonnet\n");
    expect(edit(set, (c) => delete c.default_model)).toBe("concurrency: 3\n");
  });

  it("works on empty and comment-only text", () => {
    const out = edit("", (c) => (c.concurrency = 4));
    expect(Object.keys(parse(out))).toEqual(["concurrency"]);
    expect(editConfigText("", {}).text).toBe("");
    const kept = edit("# only a comment\n", (c) => (c.concurrency = 4));
    expect(kept).toContain("# only a comment");
    expect(parseConfigText(kept).concurrency).toBe(4);
  });

  it("empties a file whose only key goes back to its default", () => {
    expect(edit("concurrency: 3\n", (c) => (c.concurrency = parseConfigText("").concurrency))).toBe("");
  });

  it("refuses a bad body and names the key", () => {
    expect(() => editConfigText("", { audit: { retention_days: 0 } })).toThrow(/retention_days/);
    expect(() => editConfigText("", { nope: 1 })).toThrow();
  });

  it("refuses broken YAML", () => {
    expect(() => editConfigText("a: [1\n", { concurrency: 4 }, "x.yaml")).toThrow();
    const broken = "concurrency: 3\n  bad: : :\n";
    expect(() => editConfigText(broken, { concurrency: 4 })).toThrow();
  });

  it("refuses a list too long to align, and writes nothing", () => {
    const n = Math.ceil(Math.sqrt(SEQ_WORK_LIMIT)) + 10;
    const mk = (p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const text = `protected_branches:\n${mk("a").map((b) => `  - ${b}\n`).join("")}`;
    expect(() => editConfigText(text, { protected_branches: [...mk("b"), "x"] })).toThrow(/too long/);
  });
});

describe("configVersion", () => {
  it("names the text", () => {
    expect(configVersion("a: 1\n")).toBe(configVersion("a: 1\n"));
    expect(configVersion("a: 2\n")).not.toBe(configVersion("a: 1\n"));
    expect(configVersion("")).toBeTypeOf("string");
    expect(configVersion("")).not.toBe("");
  });
});

describe("saveConfig", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "config-save-"));

  it("creates a missing file with only the changed key", () => {
    const p = join(dir(), "sub", "config.yaml");
    const c = JSON.parse(JSON.stringify(parseConfigText(""))) as Config;
    c.concurrency = 4;
    saveConfig(c, p);
    expect(readFileSync(p, "utf8")).toBe("concurrency: 4\n");
  });

  it("creates nothing when nothing changes", () => {
    const p = join(dir(), "config.yaml");
    saveConfig({}, p);
    expect(existsSync(p)).toBe(false);
  });

  it("leaves the file alone for an invalid body", () => {
    const p = join(dir(), "config.yaml");
    writeFileSync(p, "# mine\nconcurrency: 3\n");
    expect(() => saveConfig({ concurrency: -1 }, p)).toThrow();
    expect(readFileSync(p, "utf8")).toBe("# mine\nconcurrency: 3\n");
  });
});

describe("resetConfigText", () => {
  const reset = (text: string, key: string) => resetConfigText(text, key);

  it("removes a changed value, a stored default and a commented override", () => {
    expect(reset("monitor:\n  restart_loop:\n    resumes: 7\n", "monitor.restart_loop.resumes").text).toBe("");
    expect(reset("monitor:\n  restart_loop:\n    resumes: 5\n    within_minutes: 20\n", "monitor.restart_loop.resumes").text).toBe("monitor:\n  restart_loop:\n    within_minutes: 20\n");
    const out = reset("monitor:\n  restart_loop:\n    resumes: 7 # tuned\n    within_minutes: 20\n", "monitor.restart_loop.resumes").text;
    expect(out).toBe("monitor:\n  restart_loop:\n    within_minutes: 20\n");
    expect(out).not.toContain("tuned");
  });

  it("removes an empty parent and keeps an unrelated comment", () => {
    expect(reset("concurrency: 3 # mine\nmonitor:\n  breaker:\n    failed_fixes: 4\n", "monitor.breaker.failed_fixes").text).toBe("concurrency: 3 # mine\n");
  });

  it("keeps comment lines above the removed key", () => {
    const out = reset("monitor:\n  # set by ops\n  report_to: o/a\n  fix_wait_days: 9\n", "monitor.report_to");
    expect(out.text).toContain("# set by ops");
    expect(out.text).toContain("fix_wait_days: 9");
    expect(out.text).not.toContain("report_to");
    expect(out.config.monitor.report_to).toBeUndefined();
    const last = reset("monitor:\n  fix_wait_days: 9\n  # about the target\n  report_to: o/a\n", "monitor.report_to").text;
    expect(last).toContain("# about the target");
    expect(parseConfigText(last).monitor.fix_wait_days).toBe(9);
  });

  it("keeps the comment above a flow-style top map", () => {
    const out = reset("# keep this explanation\n{monitor: {report_to: o/a}}\n", "monitor.report_to").text;
    expect(out).toContain("# keep this explanation");
    expect(out).not.toContain("report_to");
  });

  it("gives the same text for an absent key, and the default in the config", () => {
    const t = "concurrency: 3\n";
    expect(reset(t, "monitor.report_to").text).toBe(t);
    expect(reset("", "monitor.report_to").text).toBe("");
    expect(reset("monitor:\n  restart_loop:\n    resumes: 7\n", "monitor.restart_loop.resumes").config.monitor.restart_loop.resumes).toBe(5);
  });

  it("refuses broken or invalid text", () => {
    expect(() => reset("a: [1\n", "monitor.report_to")).toThrow();
    expect(() => reset("concurrency: -1\n", "monitor.report_to")).toThrow();
  });
});
