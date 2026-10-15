import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { TOOLS_DIR } from "../engine/guards.js";

/** The mark file of a stand-in JDK folder; tools/agent-bin/_gate.mjs uses the same name. */
export const STAND_IN_MARK = "factory-java-stand-in";

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A stand-in JDK for JAVA_HOME: the real JDK by symlinks, except bin/java, which goes through the test gate of agent
 * steps (a wrapper such as ./gradlew or ./mvnw ends in `$JAVA_HOME/bin/java`). Built once per real JDK (and gate/node
 * path) under `cacheDir`; undefined when it cannot be built. Never throws.
 */
export function javaStandIn(javaHome: string, cacheDir: string, gate = join(TOOLS_DIR, "agent-bin", "_gate.mjs"), node = process.execPath): { home: string; real: string } | undefined {
  try {
    const real = realpathSync(javaHome);
    if (existsSync(join(real, STAND_IN_MARK)) || !isExecutable(join(real, "bin", "java"))) return undefined;
    const home = join(cacheDir, createHash("sha256").update(`${real}\0${gate}\0${node}`).digest("hex").slice(0, 16));
    if (existsSync(join(home, STAND_IN_MARK))) return { home, real };
    const tmp = `${home}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(join(tmp, "bin"), { recursive: true });
      for (const e of readdirSync(real)) if (e !== "bin") symlinkSync(join(real, e), join(tmp, e));
      for (const e of readdirSync(join(real, "bin"))) if (e !== "java") symlinkSync(join(real, "bin", e), join(tmp, "bin", e));
      writeFileSync(join(tmp, "bin", "java"), `#!/bin/sh\nexec ${sq(node)} ${sq(gate)} --real ${sq(join(real, "bin", "java"))} java "$@"\n`, { mode: 0o755 });
      writeFileSync(join(tmp, STAND_IN_MARK), `${real}\n`);
      renameSync(tmp, home);
    } catch {
      rmSync(tmp, { recursive: true, force: true });
      return existsSync(join(home, STAND_IN_MARK)) ? { home, real } : undefined;
    }
    return { home, real };
  } catch {
    return undefined;
  }
}

let macJavaHome: string | undefined | null = null;

/**
 * The JDK a wrapper would find itself when JAVA_HOME is not set (mvnw asks `/usr/libexec/java_home` on macOS, else it
 * resolves `javac`), so the stand-in can be set before the wrapper looks. Undefined when there is none.
 */
export function discoverJavaHome(path: string | undefined): string | undefined {
  if (process.platform === "darwin" && existsSync("/usr/libexec/java_home")) {
    if (macJavaHome === null) {
      try {
        macJavaHome = execFileSync("/usr/libexec/java_home", [], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
      } catch {
        macJavaHome = undefined;
      }
    }
    if (macJavaHome) return macJavaHome;
  }
  for (const d of (path ?? "").split(delimiter)) {
    if (!d) continue;
    try {
      const javac = realpathSync(join(d, "javac"));
      const home = dirname(dirname(javac));
      if (basename(dirname(javac)) === "bin" && isExecutable(join(home, "bin", "java")) && home !== "/usr") return home;
    } catch { /* not here */ }
  }
  return undefined;
}
