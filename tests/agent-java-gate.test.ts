import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverJavaHome, javaStandIn, STAND_IN_MARK } from "../src/agents/java-gate.js";
import { testGateEnv } from "../src/agents/run.js";
// @ts-expect-error a plain ES module of the tools folder, without types
import { STAND_IN_MARK as GATE_MARK } from "../tools/agent-bin/_gate.mjs";

const exe = (f: string, body: string) => {
  writeFileSync(f, body);
  chmodSync(f, 0o755);
};

/** A fake JDK whose java logs its call (args, nice, slot) and exits 7. With NESTED unset and CALL_AGAIN set it calls itself once more first. */
function setup() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "jgate-")));
  const jdk = join(d, "jdk");
  mkdirSync(join(jdk, "bin"), { recursive: true });
  mkdirSync(join(jdk, "lib"));
  const log = join(d, "log");
  exe(
    join(jdk, "bin", "java"),
    `#!/bin/sh\necho "java $* nice=$(ps -o nice= -p $$ | tr -d ' ') slot=\${FACTORY_IN_TEST_SLOT:-}" >> "${log}"\n` +
      `if [ -n "$CALL_AGAIN" ] && [ -z "$NESTED" ]; then NESTED=1 "$JAVA_HOME/bin/java" -classpath x org.gradle.wrapper.GradleWrapperMain test; fi\nexit 7\n`,
  );
  exe(join(jdk, "bin", "javac"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(jdk, "release"), "x");
  const proj = join(d, "proj");
  mkdirSync(proj);
  exe(
    join(proj, "gradlew"),
    '#!/bin/sh\nAPP_HOME=$(cd "$(dirname "$0")" && pwd)\nif [ -n "$JAVA_HOME" ]; then J="$JAVA_HOME/bin/java"; else J=java; fi\n' +
      'exec "$J" -Dorg.gradle.appname=gradlew -classpath "$APP_HOME/gradle/wrapper/gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain "$@"\n',
  );
  exe(
    join(proj, "mvnw"),
    '#!/bin/sh\nif [ -n "$JAVA_HOME" ]; then J="$JAVA_HOME/bin/java"; else J=java; fi\nexec "$J" -classpath x org.apache.maven.wrapper.MavenWrapperMain "$@"\n',
  );
  const gate = testGateEnv([join(jdk, "bin"), process.env.PATH].join(delimiter), join(d, "runs", "x"), jdk);
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    ...gate,
    FACTORY_TEST_SLOT_POLL_MS: "50",
    FACTORY_IN_TEST_SLOT: "",
    ...extra,
  });
  const slots = join(d, "test-slots");
  const sh = (cmd: string, args: string[], extra: Record<string, string> = {}, cwd = proj) =>
    spawnSync(cmd, args, { cwd, env: env(extra), encoding: "utf8" });
  return { d, jdk, proj, log, slots, gate, env, sh };
}
const lines = (log: string) => readFileSync(log, "utf8").trim().split("\n");
const niceOf = (line: string) => Number(/nice=(\d+)/.exec(line)![1]);

describe("javaStandIn", () => {
  it("builds a JDK folder whose bin/java is the gate and the rest the real JDK, once", () => {
    const s = setup();
    const cache = join(s.d, "cache");
    const a = javaStandIn(s.jdk, cache)!;
    expect(a.real).toBe(s.jdk);
    expect(readFileSync(join(a.home, "bin", "java"), "utf8")).toContain(`_gate.mjs' --real '${join(s.jdk, "bin", "java")}' java`);
    expect(lstatSync(join(a.home, "bin", "java")).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(a.home, "bin", "javac"))).toBe(join(s.jdk, "bin", "javac"));
    expect(realpathSync(join(a.home, "lib"))).toBe(join(s.jdk, "lib"));
    expect(realpathSync(join(a.home, "release"))).toBe(join(s.jdk, "release"));
    expect(existsSync(join(a.home, STAND_IN_MARK))).toBe(true);
    expect(javaStandIn(s.jdk, cache)).toEqual(a);
    expect(readdirSync(cache)).toEqual([a.home.slice(cache.length + 1)]);
  });

  it("gives up quietly: a stand-in as the JDK, no bin/java, a cache folder that cannot be made", () => {
    const s = setup();
    const a = javaStandIn(s.jdk, join(s.d, "cache"))!;
    expect(javaStandIn(a.home, join(s.d, "cache2"))).toBeUndefined();
    mkdirSync(join(s.d, "empty"));
    expect(javaStandIn(join(s.d, "empty"), join(s.d, "cache"))).toBeUndefined();
    expect(javaStandIn(join(s.d, "missing"), join(s.d, "cache"))).toBeUndefined();
    writeFileSync(join(s.d, "file"), "x");
    expect(javaStandIn(s.jdk, join(s.d, "file", "sub"))).toBeUndefined();
  });

  it("uses the same mark name as the gate", () => expect(STAND_IN_MARK).toBe(GATE_MARK));

  it.skipIf(process.platform === "darwin")("discovers the JDK of the javac on the PATH", () => {
    const s = setup();
    expect(discoverJavaHome(join(s.jdk, "bin"))).toBe(s.jdk);
    expect(discoverJavaHome(join(s.d, "nothing"))).toBeUndefined();
  });
});

describe("testGateEnv with a JDK", () => {
  it("sets JAVA_HOME to a stand-in under <data>/agent-java and the real JDK next to it", () => {
    const s = setup();
    expect(s.gate.FACTORY_REAL_JAVA_HOME).toBe(s.jdk);
    expect(s.gate.JAVA_HOME.startsWith(join(s.d, "agent-java"))).toBe(true);
  });
  it.skipIf(process.platform === "darwin")("finds the JDK itself when JAVA_HOME is not set, as a wrapper does", () => {
    const s = setup();
    const env = testGateEnv(join(s.jdk, "bin"), join(s.d, "runs", "x"));
    expect(env.FACTORY_REAL_JAVA_HOME).toBe(s.jdk);
    expect(existsSync(join(env.JAVA_HOME!, STAND_IN_MARK))).toBe(true);
  });
  it("sets no JAVA_HOME for a JDK that is not usable", () => {
    const s = setup();
    const env = testGateEnv("/usr/bin", join(s.d, "runs", "x"), join(s.d, "missing"));
    expect(env.JAVA_HOME).toBeUndefined();
    expect(env.FACTORY_REAL_JAVA_HOME).toBeUndefined();
  });
});

describe("wrappers started by their path", () => {
  it("./gradlew test takes a slot at low priority and a low-priority daemon", () => {
    const s = setup();
    const r = s.sh("./gradlew", ["test"]);
    expect(r.status).toBe(7);
    const l = lines(s.log)[0]!;
    expect(l).toContain("GradleWrapperMain -Dorg.gradle.priority=low test");
    expect(l).toContain("slot=1");
    expect(niceOf(l)).toBeGreaterThanOrEqual(10);
    expect(readdirSync(s.slots)).toEqual([]);
  });

  it("./mvnw verify takes a slot at low priority, without a Gradle flag", () => {
    const s = setup();
    expect(s.sh("./mvnw", ["verify"]).status).toBe(7);
    const l = lines(s.log)[0]!;
    expect(l).toMatch(/MavenWrapperMain verify nice=\d+ slot=1$/);
    expect(niceOf(l)).toBeGreaterThanOrEqual(10);
  });

  it("other goals run unchanged and take no slot", () => {
    const s = setup();
    for (const [cmd, goal] of [["./gradlew", "assemble"], ["./gradlew", "--version"], ["./gradlew", "compileJava"], ["./mvnw", "compile"]] as const) {
      expect(s.sh(cmd, [goal]).status).toBe(7);
    }
    const ls = lines(s.log);
    expect(ls.length).toBe(4);
    for (const l of ls) {
      expect(l).toMatch(/slot=$/);
      expect(l).not.toContain("priority");
    }
    expect(existsSync(s.slots)).toBe(false);
  });

  it("by absolute path and as `sh ./gradlew :app:test`", () => {
    const s = setup();
    expect(s.sh(join(s.proj, "gradlew"), ["test"], {}, s.d).status).toBe(7);
    expect(s.sh("sh", ["./gradlew", ":app:test"]).status).toBe(7);
    const ls = lines(s.log);
    expect(ls.map((l) => l.includes("slot=1"))).toEqual([true, true]);
    expect(ls[1]).toContain("-Dorg.gradle.priority=low :app:test");
  });

  it("without JAVA_HOME the java on the PATH is gated", () => {
    const s = setup();
    const gate = { ...s.gate } as Record<string, string | undefined>;
    delete gate.JAVA_HOME;
    delete gate.FACTORY_REAL_JAVA_HOME;
    const r = spawnSync("./gradlew", ["test"], { cwd: s.proj, env: { ...s.env(), ...gate, JAVA_HOME: "", FACTORY_REAL_JAVA_HOME: "" }, encoding: "utf8" });
    expect(r.status).toBe(7);
    expect(lines(s.log)[0]).toContain("slot=1");
  });

  it("a Gradle start inside a slot asks for no second slot, but still gets the low-priority daemon", () => {
    const s = setup();
    const t = Date.now();
    const r = s.sh("./gradlew", ["test"], { CALL_AGAIN: "1", FACTORY_VAR_TEST_SLOTS: "1", FACTORY_AGENT_TEST_WAIT_SEC: "5" });
    expect(r.status).toBe(7);
    expect(r.stdout).not.toContain("waiting for a free slot");
    expect(Date.now() - t).toBeLessThan(4000);
    const ls = lines(s.log);
    expect(ls.length).toBe(2);
    expect(ls[1]).toContain("-Dorg.gradle.priority=low");
    expect(ls[1]).toContain("slot=1");
  });

  it("already inside a slot from the start: no slots folder, the daemon priority is set", () => {
    const s = setup();
    expect(s.sh("./gradlew", ["test"], { FACTORY_IN_TEST_SLOT: "1" }).status).toBe(7);
    expect(lines(s.log)[0]).toContain("-Dorg.gradle.priority=low test");
    expect(existsSync(s.slots)).toBe(false);
  });

  it("a java found on the PATH keeps the PATH's JDK, not the JAVA_HOME one; the stand-in's java uses its own JDK", () => {
    const s = setup();
    const other = join(s.d, "jdk-other", "bin");
    mkdirSync(other, { recursive: true });
    exe(join(other, "java"), `#!/bin/sh\necho "other $*" >> "${s.log}"\nexit 8\n`);
    const path = [s.gate.PATH.split(delimiter)[0], other, s.gate.PATH].join(delimiter);
    const viaPath = spawnSync("java", ["-jar", "app.jar"], { env: { ...s.env(), PATH: path }, encoding: "utf8" });
    expect(viaPath.status).toBe(8);
    expect(lines(s.log)).toEqual(["other -jar app.jar"]);
    const viaHome = spawnSync(join(s.gate.JAVA_HOME, "bin", "java"), ["-jar", "app.jar"], { env: { ...s.env(), PATH: path }, encoding: "utf8" });
    expect(viaHome.status).toBe(7);
    expect(lines(s.log)[1]).toMatch(/^java -jar app.jar /);
  });

  it("a stand-in bin/ on the PATH does not make the gate call itself", () => {
    const s = setup();
    const path = [join(s.gate.JAVA_HOME, "bin"), s.gate.PATH].join(delimiter);
    const r = spawnSync("java", ["-version"], { env: { ...s.env(), PATH: path, FACTORY_REAL_JAVA_HOME: "" }, encoding: "utf8", timeout: 10000 });
    expect(r.status).toBe(7);
    expect(lines(s.log)).toHaveLength(1);
  });
});
