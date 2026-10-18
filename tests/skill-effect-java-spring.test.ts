import { execFile, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scenarioOffers } from "../src/skill-eval/effect.js";
import { credentialProblem, riskyFileName } from "../src/skills/credential-scan.js";
import { instructionFixtureHash } from "../src/skills/evaluation-instructions.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";
import { normalizeSkill, type NormalizeOrigin } from "../src/skills/normalize.js";
import { loadSkillPackage, type SkillPackage } from "../src/skills/package.js";
import type { RegisteredSkill } from "../src/skills/registry.js";

const SUITE_DIR = fileURLToPath(new URL("../evals/skill-gate/java-spring", import.meta.url));
const ORDERS = join(SUITE_DIR, "fixtures/orders-service");
const CACHE = join(SUITE_DIR, "fixtures/cache-library");

const read = readEvaluationSuite(join(SUITE_DIR, "suite.yaml"));
const ins = read.state === "ok" ? read.suite.instructions! : undefined;

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const copy = (fixture: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "javaeffect-")));
  made.push(dir);
  cpSync(fixture, dir, { recursive: true });
  return dir;
};
const fixtureOf = (repo: string) => (repo.endsWith("cache-library") ? CACHE : ORDERS);

/** 0 for success, the exit code for a failure, null when the process could not run or was killed. */
const exit = (cwd: string, check: string): Promise<number | null> =>
  new Promise((done) => {
    execFile("sh", ["-c", check], { cwd, timeout: 30_000 }, (err) => {
      if (!err) return done(0);
      done(typeof err.code === "number" ? err.code : null);
    });
  });
const run = (file: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> =>
  new Promise((done) => {
    execFile(file, args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, out: stdout + stderr });
    });
  });

const A: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };
const bytes = (path: string, text: string) => ({ path, content: new Uint8Array(Buffer.from(text)) });
const capSkill = (caps: string): SkillPackage => {
  const r = normalizeSkill(A, {
    root: "skills/x",
    files: [bytes("SKILL.md", "---\nname: notes\ndescription: About notes.\n---\n\nBody.\n"), bytes("skill.yaml", `capabilities: [${caps}]\n`)],
  });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill.package;
};
const entry = (pkg: SkillPackage): RegisteredSkill => ({
  key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: "test", dir: "", active: true,
  trust: "approved", pin: "pinned", digest: pkg.digest, pkg,
});
const offeredIds = (pkg: SkillPackage): string[] =>
  scenarioOffers(entry(pkg), SUITE_DIR, ins!).filter((o) => o.offered).map((o) => o.id).sort();

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const ALL = ["cancel-rules", "log-load-failure", "optimistic-locking", "single-load"];

describe("the java and spring effect scenarios (no JDK needed)", () => {
  it("is a valid suite with four scenarios, repeat 4 and mandatory false", () => {
    expect(read.state).toBe("ok");
    expect(ins?.mandatory).toBe(false);
    expect(ins?.repeat).toBe(4);
    expect(ins?.scenarios.map((s) => s.id).sort()).toEqual(ALL);
    for (const s of ins!.scenarios) {
      expect(s.policy, s.id).toEqual({ shell: false, network: false, filesystem: "write" });
      expect(s.check.length, s.id).toBeLessThanOrEqual(2000);
      expect(s.check, s.id).toContain("mktemp -d");
      expect(s.check, s.id).toContain("halt(2)");
      expect(s.check, s.id).toContain("System.exit");
      const java = /printf '%s' '([^']*)'/.exec(s.check)?.[1];
      expect(java, s.id).toBeDefined();
      expect(java, s.id).not.toContain("//");
      if (s.repo.endsWith("orders-service")) expect(s.task, s.id).toContain("src/stubs/java");
      else expect(s.task, s.id).not.toMatch(/spring[\s-]?boot/i);
    }
  });

  it("offers a [java] skill on every scenario", () => {
    expect(offeredIds(capSkill("java"))).toEqual(ALL);
    expect(offeredIds(loadSkillPackage(resolve("skills/java")))).toEqual(ALL);
  });

  it("offers a [spring-boot] skill only on the orders-service scenarios", () => {
    expect(offeredIds(capSkill("spring-boot"))).toEqual(["cancel-rules", "optimistic-locking"]);
    expect(offeredIds(loadSkillPackage(resolve("skills/spring-boot")))).toEqual(["cancel-rules", "optimistic-locking"]);
  });

  it("offers a [kafka] skill nowhere", () => {
    expect(offeredIds(capSkill("kafka"))).toEqual([]);
  });

  it("cache-library has no link, agent config, credential or network build", () => {
    const h = instructionFixtureHash(CACHE);
    if (!("hash" in h)) throw new Error(h.problem);
    expect(h.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const p of filesUnder(CACHE)) {
      const rel = relative(CACHE, p);
      expect(riskyFileName(rel), rel).toBe(false);
      expect(credentialProblem(readFileSync(p, "utf8")), rel).toBeUndefined();
      expect(rel.split(/[\\/]/).length - 1).toBeLessThanOrEqual(8);
    }
    const gradle = readFileSync(join(CACHE, "build.gradle"), "utf8");
    expect(gradle).toContain("java-library");
    expect(gradle).toContain("JavaLanguageVersion.of(17)");
    expect(gradle).not.toMatch(/repositories|mavenCentral|https?:/);
  });
});

const jdk = spawnSync("javac", ["-version"], { stdio: "ignore" }).status === 0;
if (!jdk) console.warn("skill-effect-java-spring JDK tests skipped: they need javac");

describe.skipIf(!jdk)("the java and spring effect checks (JDK)", () => {
  const checkOf = (id: string): string => ins!.scenarios.find((s) => s.id === id)!.check;
  const ORDER_DIR = "src/main/java/com/example/orders";
  const CACHE_FILE = "src/main/java/org/example/cache/LoadingCache.java";

  const REFERENCE_CACHE = `package org.example.cache;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.logging.Level;
import java.util.logging.Logger;

public class LoadingCache<K, V> {
  private static final Logger LOG = Logger.getLogger(LoadingCache.class.getName());
  private final Map<K, V> values = new ConcurrentHashMap<>();
  private final Function<? super K, ? extends V> loader;

  public LoadingCache(Function<? super K, ? extends V> loader) {
    this.loader = Objects.requireNonNull(loader, "loader");
  }

  public V get(K key) {
    return values.computeIfAbsent(key, k -> {
      try {
        return loader.apply(k);
      } catch (RuntimeException e) {
        LOG.log(Level.WARNING, "loading " + k + " failed", e);
        throw e;
      }
    });
  }

  public void invalidate(K key) {
    values.remove(key);
  }

  public int size() {
    return values.size();
  }
}
`;
  const original = (fixture: string, file: string) => readFileSync(join(fixture, file), "utf8");
  const swap = (text: string, from: string, to: string): string => {
    const out = text.replace(from, to);
    expect(out).not.toBe(text);
    return out;
  };
  const REFERENCE_ORDER = swap(
    swap(original(ORDERS, `${ORDER_DIR}/Order.java`), "import jakarta.persistence.Id;", "import jakarta.persistence.Id;\nimport jakarta.persistence.Version;"),
    "  private Long id;\n", "  private Long id;\n  @Version\n  private long version;\n");
  const REFERENCE_SERVICE = swap(
    original(ORDERS, `${ORDER_DIR}/OrderService.java`),
    `.orElseThrow(() -> new NoSuchElementException("no order " + id));\n`,
    `.orElseThrow(() -> new NoSuchElementException("no order " + id));\n    if (order.getStatus() == Order.Status.PAID) throw new IllegalStateException("a paid order cannot be cancelled");\n`);

  const write = (dir: string, file: string, text: string) => writeFileSync(join(dir, file), text);
  const withOrders = (order: string, service: string): string => {
    const dir = copy(ORDERS);
    write(dir, `${ORDER_DIR}/Order.java`, order);
    write(dir, `${ORDER_DIR}/OrderService.java`, service);
    return dir;
  };
  const withCache = (source: string): string => {
    const dir = copy(CACHE);
    write(dir, CACHE_FILE, source);
    return dir;
  };
  const dirFor = (id: string): string => copy(fixtureOf(ins!.scenarios.find((s) => s.id === id)!.repo));
  const status = async (dir: string, id: string) => ({ id, status: await exit(dir, checkOf(id)) });

  /** Compiles the fixture sources (and its own test) with the plain JDK and runs the test class. */
  const ownTest = async (dir: string, srcs: string[], main: string) => {
    const out = join(dir, "out-classes");
    const files = srcs.flatMap((d) => filesUnder(join(dir, d))).filter((p) => p.endsWith(".java"));
    const c = await run("javac", ["-d", out, ...files], dir);
    if (c.code !== 0) return c;
    return run("java", ["-cp", out, main], dir);
  };

  it("the Gradle library passes its own test with the plain JDK", async () => {
    const r = await ownTest(copy(CACHE), ["src/main/java", "src/test/java"], "org.example.cache.LoadingCacheTest");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("OK");
  });

  it("fails every check on the unchanged fixtures, also when the keywords are only in comments", async () => {
    const stuffing = "\n/* @Version private long version; IllegalStateException PAID synchronized computeIfAbsent ConcurrentHashMap Level.WARNING log rethrow */\n";
    const stuffed = (id: string): string => {
      const dir = dirFor(id);
      for (const f of [`${ORDER_DIR}/Order.java`, `${ORDER_DIR}/OrderService.java`, CACHE_FILE]) {
        try {
          write(dir, f, readFileSync(join(dir, f), "utf8") + stuffing);
        } catch {
          // the file belongs to the other fixture
        }
      }
      return dir;
    };
    const runs = await Promise.all([
      ...ALL.map((id) => status(dirFor(id), id)),
      ...ALL.map((id) => status(stuffed(id), id)),
    ]);
    for (const r of runs) expect(r).toEqual({ id: r.id, status: 1 });
  });

  it("passes every check on a reference solution, which keeps the fixture tests green", async () => {
    const orders = withOrders(REFERENCE_ORDER, REFERENCE_SERVICE);
    const cache = withCache(REFERENCE_CACHE);
    // Informational logging of a successful load must not fail the check: only WARNING and above counts.
    const chatty = withCache(swap(REFERENCE_CACHE, "        return loader.apply(k);\n", "        V v = loader.apply(k);\n        LOG.info(\"loaded \" + k);\n        return v;\n"));
    const runs = await Promise.all([
      status(orders, "cancel-rules"),
      status(orders, "optimistic-locking"),
      status(cache, "single-load"),
      status(cache, "log-load-failure"),
      status(chatty, "log-load-failure"),
    ]);
    for (const r of runs) expect(r).toEqual({ id: r.id, status: 0 });
    const tests = await Promise.all([
      ownTest(orders, ["src/stubs/java", "src/main/java", "src/test/java"], "com.example.orders.OrderServiceTest"),
      ownTest(cache, ["src/main/java", "src/test/java"], "org.example.cache.LoadingCacheTest"),
    ]);
    for (const t of tests) expect(t.code, t.out).toBe(0);
  });

  it("fails near misses", async () => {
    // Changes the order first and throws afterwards: the PAID order is no longer unchanged.
    const cancelThenThrow = swap(
      original(ORDERS, `${ORDER_DIR}/OrderService.java`),
      `    order.setStatus(Order.Status.CANCELLED);\n`,
      `    boolean paid = order.getStatus() == Order.Status.PAID;\n    order.setStatus(Order.Status.CANCELLED);\n    if (paid) throw new IllegalStateException("paid");\n`);
    const alwaysThrows = REFERENCE_SERVICE.replace("if (order.getStatus() == Order.Status.PAID) throw", "if (order != null) throw");
    expect(alwaysThrows).not.toBe(REFERENCE_SERVICE);
    const stringVersion = REFERENCE_ORDER.replace("private long version;", "private String version;");
    const twoVersions = REFERENCE_ORDER.replace("private long version;", "private long version;\n  @Version\n  private long other;");
    const finalVersion = REFERENCE_ORDER.replace("private long version;", "private final long version = 0;");
    const original_service = original(ORDERS, `${ORDER_DIR}/OrderService.java`);
    const original_order = original(ORDERS, `${ORDER_DIR}/Order.java`);

    // get then put on a concurrent map: not atomic.
    const checkThenPut = REFERENCE_CACHE.replace(
      /    return values\.computeIfAbsent[\s\S]*?\n    \}\);\n/,
      "    V v = values.get(key);\n    if (v == null) {\n      v = loader.apply(key);\n      values.put(key, v);\n    }\n    return v;\n");
    expect(checkThenPut).not.toBe(REFERENCE_CACHE);
    // The second caller arrives late, inside get (it spins, so it is running, not waiting on the cache): there is no contention.
    const lateCaller = checkThenPut.replace(
      "  public V get(K key) {\n",
      "  private final java.util.concurrent.atomic.AtomicBoolean first = new java.util.concurrent.atomic.AtomicBoolean(true);\n\n  public V get(K key) {\n    if (!first.getAndSet(false)) {\n      long end = System.nanoTime() + 800_000_000L;\n      while (System.nanoTime() < end) Thread.onSpinWait();\n    }\n");
    expect(lateCaller).not.toBe(checkThenPut);
    const wrapsException = swap(REFERENCE_CACHE, "        throw e;\n", "        throw new RuntimeException(e);\n");
    const alwaysWarns = swap(
      swap(REFERENCE_CACHE, "  public V get(K key) {\n", "  public V get(K key) {\n    LOG.log(Level.WARNING, \"get \" + key);\n"),
      "LOG.log(Level.WARNING, \"loading \" + k + \" failed\", e);\n", "");
    const noKey = swap(REFERENCE_CACHE, "\"loading \" + k + \" failed\"", "\"loading failed\"");
    const noThrown = swap(REFERENCE_CACHE, "\"loading \" + k + \" failed\", e)", "\"loading \" + k + \" failed\")");

    const runs = await Promise.all([
      status(withOrders(original_order, cancelThenThrow), "cancel-rules"),
      status(withOrders(original_order, alwaysThrows), "cancel-rules"),
      status(withOrders(stringVersion, original_service), "optimistic-locking"),
      status(withOrders(twoVersions, original_service), "optimistic-locking"),
      status(withOrders(finalVersion, original_service), "optimistic-locking"),
      status(withCache(checkThenPut), "single-load"),
      status(withCache(lateCaller), "single-load"),
      status(withCache(wrapsException), "log-load-failure"),
      status(withCache(alwaysWarns), "log-load-failure"),
      status(withCache(noKey), "log-load-failure"),
      status(withCache(noThrown), "log-load-failure"),
    ]);
    for (const r of runs) expect(r).toEqual({ id: r.id, status: 1 });
  });
});
