import { describe, expect, it } from "vitest";
import { parseConfigTextStrict, type ServiceConfig } from "../src/config.js";
import { watchServiceConfig } from "../src/services/watch.js";

// The config.yaml watcher (#941): unit tests, tick() by hand, no timers, no server.

const entry = (args = "a") => `  - name: bot\n    command: /bin/true\n    args: [${args}]\n    scope: ["GET health"]\n`;
const text = (args = "a", extra = "concurrency: 1\n") => `${extra}services:\n${entry(args)}`;

function make(initialText: string, initial: readonly ServiceConfig[] = []) {
  let current: string | Error = initialText;
  const applied: (readonly ServiceConfig[])[] = [];
  const lines: string[] = [];
  const w = watchServiceConfig({
    read: () => {
      if (current instanceof Error) throw current;
      return current;
    },
    parse: (t) => parseConfigTextStrict(t, "config.yaml").services,
    initial,
    apply: (l) => applied.push(l),
    log: (l) => lines.push(l),
  });
  return { w, applied, lines, set: (t: string | Error) => (current = t), ticks: (n: number) => { for (let i = 0; i < n; i++) w.tick(); } };
}

describe("watchServiceConfig", () => {
  it("applies a new valid text on the second check, not the first", () => {
    const t = make("concurrency: 1\n");
    t.ticks(3);
    t.set(text());
    t.w.tick();
    expect(t.applied).toHaveLength(0);
    t.w.tick();
    expect(t.applied).toHaveLength(1);
    expect(t.applied[0]![0]!.name).toBe("bot");
    t.ticks(3);
    expect(t.applied).toHaveLength(1);
  });

  it("applies only the last of two quick edits", () => {
    const t = make("concurrency: 1\n");
    t.ticks(2);
    t.set(text("a"));
    t.w.tick();
    t.set(text("b"));
    t.ticks(2);
    expect(t.applied).toHaveLength(1);
    expect(t.applied[0]![0]!.args).toEqual(["b"]);
  });

  it("A, B, A, B: B needs two equal checks in a row", () => {
    const t = make(text("a"), [{ name: "bot", command: "/bin/true", args: ["a"], env: {}, scope: ["GET health"] }]);
    t.ticks(2);
    t.set(text("b"));
    t.w.tick();
    t.set(text("a"));
    t.w.tick();
    t.set(text("b"));
    t.w.tick();
    expect(t.applied).toHaveLength(0);
    t.w.tick();
    expect(t.applied).toHaveLength(1);
  });

  it("a failed read restarts the count", () => {
    const t = make("concurrency: 1\n");
    t.ticks(2);
    t.set(text("b"));
    t.w.tick();
    t.set(new Error("EBUSY"));
    t.w.tick();
    t.set(text("b"));
    t.w.tick();
    expect(t.applied).toHaveLength(0);
    t.w.tick();
    expect(t.applied).toHaveLength(1);
  });

  it("a change to another setting only applies nothing", () => {
    const t = make(text("a", "concurrency: 1\n"), [{ name: "bot", command: "/bin/true", args: ["a"], env: {}, scope: ["GET health"] }]);
    t.ticks(2);
    t.set(text("a", "concurrency: 2\n"));
    t.ticks(4);
    expect(t.applied).toHaveLength(0);
    expect(t.lines).toHaveLength(0);
  });

  it("invalid YAML and a refused schema change nothing and are logged once", () => {
    const t = make("concurrency: 1\n");
    t.ticks(2);
    t.set("services: [unclosed SECRET-MARKER\n");
    t.ticks(4);
    expect(t.applied).toHaveLength(0);
    expect(t.lines).toHaveLength(1);
    t.set(`services:\n  - name: bot\n    command: /bin/true\n    scope: []\n    bogus: SECRET-MARKER\n`);
    t.ticks(4);
    expect(t.applied).toHaveLength(0);
    expect(t.lines).toHaveLength(2);
    expect(t.lines.join("\n")).not.toContain("SECRET-MARKER");
    t.set(text());
    t.ticks(2);
    expect(t.applied).toHaveLength(1);
  });

  it.each([["empty", ""], ["spaces", "  \n"], ["comments only", "# nothing\n"], ["---", "---\n"], ["null", "null\n"], ["a list", "- a\n"]])(
    "%s changes nothing and is logged once",
    (_n, body) => {
      const t = make(text(), [{ name: "bot", command: "/bin/true", args: ["a"], env: {}, scope: ["GET health"] }]);
      t.ticks(2);
      t.set(body);
      t.ticks(5);
      expect(t.applied).toHaveLength(0);
      expect(t.lines).toHaveLength(1);
    },
  );

  it("`services: []` does apply", () => {
    const t = make(text(), [{ name: "bot", command: "/bin/true", args: ["a"], env: {}, scope: ["GET health"] }]);
    t.ticks(2);
    t.set("services: []\n");
    t.ticks(2);
    expect(t.applied).toEqual([[]]);
  });

  it("a read that throws is logged once and applies nothing", () => {
    const t = make("concurrency: 1\n");
    t.ticks(2);
    t.set(new Error("/secret/path EACCES"));
    t.ticks(4);
    expect(t.applied).toHaveLength(0);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).not.toContain("/secret/path");
  });
});
