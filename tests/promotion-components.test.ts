import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { policyPackSha256 } from "../src/policy/evaluate.js";
import {
  COMPONENT_KINDS, componentLine, contextSelectorSha256, countVersions, emptyVersionBook, flowSha256, flowVersion, lookupVersions, modelRoutesSha256,
} from "../src/promotion/components.js";
import { MAX_VERSIONS_BYTES, serializeVersionBook } from "../src/promotion/versions.js";
import { ContextSelectorSettingsSchema } from "../src/context/select.js";
import { parseToolProfile } from "../src/tool-profile/parse.js";
import { toolProfileRef, toolProfileSha256 } from "../src/tool-profile/resolve.js";
import { ToolProfileSchemaError } from "../src/tool-profile/version.js";
import { coverPack } from "./fixtures/policy-pack.js";

const FLOW_A = `
# a comment
name: demo
description: Demo
vars:
  b: "2"
  a: "1"
steps:
  - id: one
    type: shell
    run: echo one
  - id: two
    type: shell
    run: echo two
`;
const FLOW_B = `
steps:
  - run: echo one
    type: shell
    id: one
  - run: echo two # same
    type: shell
    id: two
vars:
  a: "1"
  b: "2"
description: Demo
name: demo
`;
const flow = (text: string) => parseFlow(text);

describe("flow components", () => {
  it("hashes the parsed flow, not its text", () => {
    expect(flowSha256(flow(FLOW_A))).toBe(flowSha256(flow(FLOW_B)));
    expect(flowSha256(flow(FLOW_A))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with a command, a limit or the step order, but not with publish.version", () => {
    const base = flowSha256(flow(FLOW_A));
    expect(flowSha256(flow(FLOW_A.replace("echo two", "echo 2")))).not.toBe(base);
    expect(flowSha256(flow(FLOW_A.replace("name: demo", "name: demo\nlimits:\n  max_cost_usd: 5")))).not.toBe(base);
    const swapped = FLOW_A.replace("echo one", "echo X").replace("echo two", "echo one").replace("echo X", "echo two");
    expect(flowSha256(flow(swapped))).not.toBe(base);
    const published = (v: number) => flow(`${FLOW_A}publish:\n  enabled: true\n  version: ${v}\n`);
    expect(flowSha256(published(1))).toBe(flowSha256(published(7)));
    expect(flowSha256(published(1))).not.toBe(base);
  });

  it("has the published version, or 0", () => {
    expect(flowVersion(flow(`${FLOW_A}publish:\n  enabled: true\n  version: 4\n`))).toBe("4");
    expect(flowVersion(flow(FLOW_A))).toBe("0");
    expect(flowVersion(flow(`${FLOW_A}publish:\n  enabled: false\n  version: 4\n`))).toBe("0");
  });
});

describe("policy pack components", () => {
  it("has the same hash for the same pack with keys in another order", () => {
    const pack = coverPack("cover", "1.4.0");
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(pack).reverse())));
    expect(policyPackSha256(reordered)).toBe(policyPackSha256(pack));
  });
});

const open = { dataClassification: "internal", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" };
const profileOf = (o: { targets?: string[]; timeoutMs?: number | null; approval?: string; descriptions?: Record<string, string> } = {}) =>
  parseToolProfile({
    version: 1,
    profile: { id: "p", version: "1" },
    grants: [
      { kind: "files", operations: ["write", "read"], targets: o.targets ?? ["/*", "src/*"], ...open, timeoutMs: o.timeoutMs ?? null, approval: o.approval ?? "none" },
      { kind: "web", operations: ["fetch"], targets: ["docs.example.com"], ...open, dataClassification: "public" },
    ],
    ...(o.descriptions ? { descriptions: o.descriptions } : {}),
  });

describe("tool profile components", () => {
  it("ignores the order of grants, operations and targets, and YAML comments", () => {
    const text = `
# comment
version: 1
profile: { id: p, version: "1" }
grants:
  - kind: web  # web
    operations: [fetch]
    targets: [docs.example.com]
    dataClassification: public
    credential: none
    timeoutMs: null
    maxConcurrent: null
    outputCapBytes: null
    approval: none
  - kind: files
    operations: [read, write]
    targets: [src/*, "/*"]
    dataClassification: internal
    credential: none
    timeoutMs: null
    maxConcurrent: null
    outputCapBytes: null
    approval: none
`;
    expect(toolProfileSha256(parseToolProfile(parse(text)))).toBe(toolProfileSha256(profileOf()));
  });

  it("changes with a target, the timeout or the approval", () => {
    const base = toolProfileSha256(profileOf());
    expect(toolProfileSha256(profileOf({ targets: ["/*"] }))).not.toBe(base);
    expect(toolProfileSha256(profileOf({ timeoutMs: 1000 }))).not.toBe(base);
    expect(toolProfileSha256(profileOf({ approval: "required" }))).not.toBe(base);
  });

  it("keeps the hash of a profile with no descriptions, and the runtime reference matches", () => {
    const plain = profileOf();
    expect(toolProfileSha256(profileOf({ descriptions: {} }))).toBe(toolProfileSha256(plain));
    const described = profileOf({ descriptions: { "files.read": "Reads a file", "web.fetch": "Gets a page" } });
    expect(toolProfileSha256(described)).not.toBe(toolProfileSha256(plain));
    expect(toolProfileRef(described).sha256).toBe(toolProfileSha256(described));
  });

  it("changes when only a description changes, not when description keys are reordered", () => {
    const a = profileOf({ descriptions: { "files.read": "Reads a file", "web.fetch": "Gets a page" } });
    const b = profileOf({ descriptions: { "web.fetch": "Gets a page", "files.read": "Reads a file" } });
    const c = profileOf({ descriptions: { "files.read": "Reads a file!", "web.fetch": "Gets a page" } });
    expect(toolProfileSha256(a)).toBe(toolProfileSha256(b));
    expect(toolProfileSha256(a)).not.toBe(toolProfileSha256(c));
  });

  it("refuses descriptions that are not valid, with an error that does not repeat the text", () => {
    const bad = (descriptions: unknown) => () => parseToolProfile({ ...profileOf(), descriptions });
    expect(bad({ "shell.run": "SECRET-1" })).toThrow(ToolProfileSchemaError);
    expect(bad({ "shell.run": "SECRET-1" })).toThrow("names a tool the profile does not grant");
    expect(bad({ "files.read": "" })).toThrow(ToolProfileSchemaError);
    expect(bad({ "files.read": "x".repeat(1001) })).toThrow(ToolProfileSchemaError);
    expect(bad({ "files.read": "a\u0007b" })).toThrow(ToolProfileSchemaError);
    expect(bad("text")).toThrow(ToolProfileSchemaError);
    expect(() => parseToolProfile({ ...profileOf(), descriptions: { "files.read": "x".repeat(1000) } })).not.toThrow();
  });
});

describe("model routes components", () => {
  const router = (yaml: string) => {
    const c = loadConfigFromText(yaml);
    return c.router;
  };
  it("has the same hash with fallback_on given as its default or left out", () => {
    const rules = "router:\n  rules:\n    - { step: build, model: a }\n    - { step: test, model: b }\n";
    expect(modelRoutesSha256(router(rules))).toBe(modelRoutesSha256(router(rules + "  fallback_on: [rate_limit, budget]\n")));
  });

  it("changes with the order of the rules", () => {
    const one = "router:\n  rules:\n    - { step: build, model: a }\n    - { step: test, model: b }\n";
    const two = "router:\n  rules:\n    - { step: test, model: b }\n    - { step: build, model: a }\n";
    expect(modelRoutesSha256(router(one))).not.toBe(modelRoutesSha256(router(two)));
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function loadConfigFromText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "components-config-"));
  writeFileSync(join(dir, "config.yaml"), text);
  return loadConfig(join(dir, "config.yaml"));
}

describe("context selector components", () => {
  const budget = { maxSources: 10, maxSourceBytes: 1000, maxTotalBytes: 5000 };
  it("ignores the default classification and the order of rules and consumers", () => {
    const a = contextSelectorSha256({ budget, rules: ["task-issue", "root-instructions"], consumers: ["coder", "planner"] });
    const b = contextSelectorSha256({ consumers: ["planner", "coder"], classification: "internal", rules: ["root-instructions", "task-issue"], budget });
    expect(a).toBe(b);
    expect(contextSelectorSha256({ budget, classification: "restricted" })).not.toBe(contextSelectorSha256({ budget }));
  });

  it("refuses an unknown key and a bad budget with the place of the field", () => {
    expect(ContextSelectorSettingsSchema.safeParse({ budget, extra: 1 }).success).toBe(false);
    const bad = ContextSelectorSettingsSchema.safeParse({ budget: { ...budget, maxSources: 0 } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]!.path.join(".")).toBe("budget.maxSources");
  });
});

describe("version counting", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const seen = (sha256: string) => ({ kind: "tool-profile" as const, id: "p", sha256 });

  it("numbers hashes by first sight and keeps the numbers", () => {
    const empty = emptyVersionBook();
    const one = countVersions(empty, [seen(A)]);
    expect(one).toMatchObject({ versions: [1], changed: true });
    const two = countVersions(one.book, [seen(B)]);
    expect(two).toMatchObject({ versions: [2], changed: true });
    const again = countVersions(two.book, [seen(A)]);
    expect(again).toMatchObject({ versions: [1], changed: false });
    expect(empty).toEqual(emptyVersionBook());
    expect(one.book.components["tool-profile/p"]).toEqual([A]);
  });

  it("looks versions up without adding", () => {
    const book = countVersions(emptyVersionBook(), [seen(A)]).book;
    expect(lookupVersions(book, [seen(A), seen(B), { kind: "model-routes", id: "default", sha256: A }])).toEqual([1, undefined, undefined]);
  });

  it("writes only a book the reader accepts, at most maxBytes long", () => {
    const book = countVersions(emptyVersionBook(), [seen(A)]).book;
    const ok = serializeVersionBook(book);
    expect(ok.ok).toBe(true);
    const size = Buffer.byteLength(ok.ok ? ok.text : "");
    expect(serializeVersionBook(book, size).ok).toBe(true);
    expect(serializeVersionBook(book, size - 1)).toMatchObject({ ok: false, reason: expect.stringContaining("larger than 4 MiB") });
    expect(serializeVersionBook({ version: 1, components: { "tool-profile/p": [A, A] } }).ok).toBe(false);
    expect(serializeVersionBook({ version: 1, components: { "flow/p": [A] } }).ok).toBe(false);
    expect(MAX_VERSIONS_BYTES).toBe(4 << 20);
  });
});

describe("componentLine", () => {
  it("prints the exact text", () => {
    const c = { kind: "flow" as const, id: "demo", version: "3", sha256: "f".repeat(64) };
    expect(componentLine(c)).toBe(`COMPONENT flow demo v3 sha256:${"f".repeat(64)}`);
    expect(componentLine(c, "builtin")).toBe(`COMPONENT flow demo v3 sha256:${"f".repeat(64)} builtin`);
    expect(componentLine({ kind: "model-routes", id: "default", sha256: "0".repeat(64) }, "unrecorded")).toBe(`COMPONENT model-routes default v- sha256:${"0".repeat(64)} unrecorded`);
    expect(COMPONENT_KINDS).toHaveLength(5);
  });
});
