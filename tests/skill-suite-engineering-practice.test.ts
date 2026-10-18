import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scenarioOffers } from "../src/skill-eval/effect.js";
import { credentialProblem } from "../src/skills/credential-scan.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import { EVALUATION_THRESHOLDS } from "../src/skills/evaluation-rules.js";
import { instructionFixtureHash } from "../src/skills/evaluation-instructions.js";
import { scoreSelection } from "../src/skills/evaluation-score.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";
import { normalizeSkill, type NormalizeOrigin } from "../src/skills/normalize.js";
import { loadSkillPackage } from "../src/skills/package.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { checkStatus, instructions as ins, put, removeWorkFolders, ROOT, suiteRead as read, workFolder } from "./engineering-practice-helpers.js";

afterAll(removeWorkFolders);

const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };
const f = (path: string, text: string) => ({ path, content: new Uint8Array(Buffer.from(text)) });
/** An imported candidate with the capabilities it declares; its id is source-qualified, so only a capability can match a task. */
function candidate(name: string, caps: string[]): CollisionCandidate {
  const files = [f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n---\n\nDo the work.\n`)];
  if (caps.length) files.push(f("skill.yaml", `capabilities: [${caps.join(", ")}]\n`));
  const r = normalizeSkill(ORIGIN, { root: `skills/${name}`, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return { skill: r.skill, approved: true, trust: "community", licencesAllowed: ["MIT"] };
}
const registered = (c: CollisionCandidate): RegisteredSkill => {
  const pkg = c.skill.package;
  return { key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: "test", dir: "", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg };
};

describe("the engineering-practice suite file", () => {
  it("has the offline sections and the instructions section", () => {
    // the parser gives `modules: []` when a case names none
    const cases = read.suite.selection.map((s) => ({ id: s.id, repo: s.repo, modules: s.modules, expect: s.expect })).sort((a, b) => a.id.localeCompare(b.id));
    expect(cases).toEqual([
      { id: "java-licence", repo: "fixtures/java-stock", modules: [], expect: "not-offered" },
      { id: "java-regression-testing", repo: "fixtures/java-stock", modules: [], expect: "offered" },
      { id: "java-test-first-testing", repo: "fixtures/java-stock", modules: [], expect: "offered" },
      { id: "java-unit-testing", repo: "fixtures/java-stock", modules: [], expect: "offered" },
      { id: "js-regression-testing", repo: "fixtures/js-cart", modules: [], expect: "offered" },
      { id: "js-rename-package", repo: "fixtures/js-cart", modules: [], expect: "not-offered" },
      { id: "js-test-first-testing", repo: "fixtures/js-cart", modules: [], expect: "offered" },
      { id: "js-unit-testing", repo: "fixtures/js-cart", modules: [], expect: "offered" },
      { id: "js-version-bump", repo: "fixtures/js-cart", modules: [], expect: "not-offered" },
    ]);
    expect(ins.mandatory).toBe(false);
    expect(ins.repeat).toBe(4);
    expect(ins.scenarios.map((s) => s.id).sort()).toEqual(["fix-negative-stock", "fix-repeated-sku", "tdd-free-shipping", "test-money-rounding", "test-reorder-rule"]);
    for (const s of ins.scenarios) expect(s.policy, s.id).toEqual({ shell: true, network: false, filesystem: "write" });
    expect([...read.profiles.keys()].sort()).toEqual(["fixtures/java-stock", "fixtures/js-cart"]);
    expect([...read.instructionFixtures.keys()].sort()).toEqual(["fixtures/java-stock", "fixtures/js-cart"]);
  });

  it("has the same conflicts, context and tools as the example suite", () => {
    const example = readEvaluationSuite(resolve("evals/skill-gate/suite.yaml"));
    if (example.state !== "ok") throw new Error(JSON.stringify(example));
    expect(read.suite.conflicts).toEqual(example.suite.conflicts);
    expect(read.suite.context).toEqual(example.suite.context);
    expect(read.suite.tools).toEqual(example.suite.tools);
  });
});

describe("selection", () => {
  it("scores 1 for a skill that declares the capability testing", () => {
    expect(scoreSelection(candidate("test-craft", ["testing"]), read.suite.selection, read.profiles, [])).toEqual({ sample: 1, findings: [] });
  });

  it("fails skills that do not name the practice of this suite", () => {
    for (const c of [candidate("systematic-debugging", []), candidate("debug-helper", ["debugging", "tdd", "regression-test"])]) {
      expect(scoreSelection(c, read.suite.selection, read.profiles, []).sample, c.skill.package.id).toBeLessThan(EVALUATION_THRESHOLDS.selection);
    }
    const kafka = loadSkillPackage(resolve("skills/kafka"));
    expect(kafka.capabilities).not.toContain("testing");
  });

  it("does not offer a skill with the capability testing on a task outside the area", () => {
    const r = scoreSelection(candidate("test-craft", ["testing"]), read.suite.selection.filter((s) => s.expect === "not-offered"), read.profiles, []);
    expect(r).toEqual({ sample: 1, findings: [] });
  });

  it("offers a skill with the capability testing in every effect scenario, and a debugging skill in the two bug fixes only", () => {
    const offered = (c: CollisionCandidate) => scenarioOffers(registered(c), ROOT, ins).filter((o) => o.offered).map((o) => o.id).sort();
    expect(offered(candidate("test-craft", ["testing"]))).toEqual(["fix-negative-stock", "fix-repeated-sku", "tdd-free-shipping", "test-money-rounding", "test-reorder-rule"]);
    expect(offered(candidate("debug-helper", ["debugging"]))).toEqual(["fix-negative-stock", "fix-repeated-sku"]);
    expect(offered(candidate("plain", []))).toEqual([]);
  });
});

describe("the fixtures", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  for (const name of ["js-cart", "java-stock"]) {
    it(`${name} has no links, executables, endpoints, credentials or agent configuration`, () => {
      const dir = join(ROOT, "fixtures", name);
      expect(instructionFixtureHash(dir)).toHaveProperty("hash");
      for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        expect(e.isFile() || e.isDirectory(), `${e.name} is a file or folder`).toBe(true);
        expect([".claude", ".mcp.json", ".git"], e.name).not.toContain(e.name);
      }
      for (const file of walk(dir)) {
        expect(statSync(file).mode & 0o111, `${file} is not executable`).toBe(0);
        const text = readFileSync(file, "utf8");
        expect(credentialProblem(text), file).toBeUndefined();
        expect(text, file).not.toMatch(/https?:\/\//);
      }
    });
  }

  it("js-cart passes its own tests", () => {
    const dir = workFolder("js-cart");
    expect((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: { test: string } }).scripts.test).toBe("node --test");
    const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

// A solution is the fixture plus changed or new files. The checks run as the flow runs them: `sh -c` in a git work folder.
const CART = readFileSync(join(ROOT, "fixtures/js-cart/src/cart.js"), "utf8");
const edit = (text: string, from: string, to: string) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};
const FIXED_CART = edit(CART, "quantity: item.quantity });", "quantity: (line?.quantity ?? 0) + item.quantity });");
const SYMPTOM_CART = edit(CART, "const subtotal = mergeLines(items).reduce((sum, l) => sum + l.priceCents * l.quantity, 0);", "const subtotal = items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);");
const TEST_HEAD = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\n';
const REPEATED_TEST = `${TEST_HEAD}import { cartTotal } from "../src/cart.js";
test("adds the quantities of a repeated sku", () => {
  const a = (quantity) => ({ sku: "a", priceCents: 250, quantity });
  assert.equal(cartTotal([a(2), a(1)]), 750);
});
`;
const OTHER_TEST = `${TEST_HEAD}import { cartTotal } from "../src/cart.js";
test("adds two different products", () => {
  assert.equal(cartTotal([{ sku: "a", priceCents: 250, quantity: 1 }, { sku: "b", priceCents: 100, quantity: 1 }]), 350);
});
`;
// The pairs a complete test refuses: negative cents, cents that are not whole, negative percent, percent above 100, percent that is not whole.
const REFUSED = ["[-1, 10]", "[1.5, 10]", "[100, -1]", "[100, 101]", "[100, 10.5]"];
const moneyTest = (refused: string[]) => `${TEST_HEAD}import { percentOf } from "../src/money.js";
test("rounds half up", () => {
  assert.equal(percentOf(999, 10), 100);
  assert.equal(percentOf(1005, 10), 101);
  assert.equal(percentOf(0, 50), 0);
  assert.equal(percentOf(200, 100), 200);
});
test("refuses what is not allowed", () => {
  for (const [c, p] of [${refused.join(", ")}]) assert.throws(() => percentOf(c, p), RangeError);
});
`;
const MONEY_TEST = moneyTest(REFUSED);
const SHIPPING = `export function shippingCents(totalCents) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new RangeError("total must be a whole number of 0 or more");
  return totalCents < 5000 ? 495 : 0;
}
`;
const CHECKOUT_CART = edit(
  edit(CART, 'import { formatCents, percentOf } from "./money.js";', 'import { formatCents, percentOf } from "./money.js";\nimport { shippingCents } from "./shipping.js";'),
  "/** One text line per sku",
  "export function checkoutTotal(items, discountPercent = 0) {\n  const total = cartTotal(items, discountPercent);\n  return total + shippingCents(total);\n}\n\n/** One text line per sku",
);
const SHIPPING_TEST = `${TEST_HEAD}import { shippingCents } from "../src/shipping.js";
test("charges below 5000 and not from 5000 on", () => {
  assert.equal(shippingCents(4999), 495);
  assert.equal(shippingCents(5000), 0);
});
test("refuses a total that is not a whole number of 0 or more", () => {
  assert.throws(() => shippingCents(-1), RangeError);
  assert.throws(() => shippingCents(10.5), RangeError);
});
`;
const SHIPPING_TEST_WEAK = `${TEST_HEAD}import { shippingCents } from "../src/shipping.js";
test("charges a small total", () => {
  assert.equal(shippingCents(100), 495);
});
`;

describe.concurrent("the checks of the JavaScript scenarios", () => {
  const status = async (id: string, files: Record<string, string>) => {
    const dir = workFolder("js-cart");
    put(dir, files);
    return checkStatus(id, dir);
  };

  it("fail on the unchanged fixture", async () => {
    for (const id of ["fix-repeated-sku", "test-money-rounding", "tdd-free-shipping"]) expect({ id, status: await status(id, {}) }).toEqual({ id, status: 1 });
  });

  it("fix-repeated-sku passes a fix with a regression test", async () => {
    expect(await status("fix-repeated-sku", { "src/cart.js": FIXED_CART, "test/repeated.test.js": REPEATED_TEST })).toBe(0);
  });

  it("fix-repeated-sku fails a correct fix without a regression test", async () => {
    expect(await status("fix-repeated-sku", { "src/cart.js": FIXED_CART })).toBe(1);
  });

  it("fix-repeated-sku fails a fix with a test that also passes on the old code", async () => {
    expect(await status("fix-repeated-sku", { "src/cart.js": FIXED_CART, "test/other.test.js": OTHER_TEST })).toBe(1);
  });

  it("fix-repeated-sku fails a patch of the symptom in one function", async () => {
    expect(await status("fix-repeated-sku", { "src/cart.js": SYMPTOM_CART, "test/repeated.test.js": REPEATED_TEST })).toBe(1);
  });

  it("test-money-rounding passes tests that catch every planted fault", async () => {
    expect(await status("test-money-rounding", { "test/money.test.js": MONEY_TEST })).toBe(0);
  });

  it("test-money-rounding fails tests with one weak case", async () => {
    const weak = `${TEST_HEAD}import { percentOf } from "../src/money.js";\ntest("a round number", () => assert.equal(percentOf(200, 10), 20));\n`;
    expect(await status("test-money-rounding", { "test/money.test.js": weak })).toBe(1);
  });

  for (const [i, pair] of REFUSED.entries()) {
    it(`test-money-rounding fails tests that do not refuse ${pair}`, async () => {
      expect(await status("test-money-rounding", { "test/money.test.js": moneyTest(REFUSED.filter((_, j) => j !== i)) })).toBe(1);
    });
  }

  it("test-money-rounding plants its faults in the original source, also when the solution edited it", async () => {
    const money = readFileSync(join(ROOT, "fixtures/js-cart/src/money.js"), "utf8");
    expect(await status("test-money-rounding", { "test/money.test.js": MONEY_TEST, "src/money.js": `${money}\n// edited\n` })).toBe(0);
  });

  it("tdd-free-shipping passes the rule with tests for its edges", async () => {
    expect(await status("tdd-free-shipping", { "src/shipping.js": SHIPPING, "src/cart.js": CHECKOUT_CART, "test/shipping.test.js": SHIPPING_TEST })).toBe(0);
  });

  it("tdd-free-shipping fails a correct rule whose tests skip the edges", async () => {
    expect(await status("tdd-free-shipping", { "src/shipping.js": SHIPPING, "src/cart.js": CHECKOUT_CART, "test/shipping.test.js": SHIPPING_TEST_WEAK })).toBe(1);
  });

  it("tdd-free-shipping fails a rule that is wrong at 5000", async () => {
    const wrong = SHIPPING.replace("< 5000 ? 495 : 0", "> 5000 ? 0 : 495");
    expect(wrong).not.toBe(SHIPPING);
    expect(await status("tdd-free-shipping", { "src/shipping.js": wrong, "src/cart.js": CHECKOUT_CART, "test/shipping.test.js": SHIPPING_TEST })).toBe(1);
  });
});
