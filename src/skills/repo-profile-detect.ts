/**
 * Content detectors for the repository profile. Pure: text in, findings out, never throws, starts no process.
 * Only identifiers that pass TOKEN_RE reach a finding; free text from the repository is dropped.
 */
import { builtinModules } from "node:module";
import { parse as parseYaml } from "yaml";
import type { FindingKind } from "./repo-profile-rules.js";

export interface RawFinding {
  kind: FindingKind;
  name: string;
  value?: string;
  detector: string;
  reason: string;
  /** Source file when it is not the file given to the detector (commands). */
  path?: string;
}

export const TOKEN_RE = /^[@A-Za-z0-9._/:~^<>=*+-]{1,120}$/;
const COMMAND_RE = /^[@A-Za-z0-9._/:~^<>=*+ -]{1,120}$/;
const MAX_LINE = 500;
const MAX_DEPS = 400;

export const cleanToken = (s: string, allowSpace = false): string | undefined => {
  const t = s.trim();
  return (allowSpace ? COMMAND_RE : TOKEN_RE).test(t) && t === s ? t : undefined;
};

/** Match with up to three capture groups typed as strings; a group that did not take part is undefined at run time, so check optional ones. */
type Match = [string, string, string, string];
const ex = (re: RegExp, s: string): Match | null => re.exec(s) as Match | null;

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.length <= MAX_LINE);

const NUM_VERSION = "[~^<>=]{0,3}v?\\d[0-9A-Za-z.*+-]{0,60}";
// Plain versions, common dist-tags and workspace/catalog references; URLs, VCS forms and credentials never match.
const SAFE_VERSION = new RegExp(`^(?:\\*|${NUM_VERSION}|latest|next|beta|alpha|canary|rc|stable|dev|workspace:(?:\\*|[~^]?|${NUM_VERSION})|catalog:[A-Za-z0-9_-]{0,40})$`);

function dep(file: string, name: string, version: string | undefined, section: string): RawFinding | undefined {
  const n = cleanToken(name);
  if (!n) return undefined;
  const f: RawFinding = {
    kind: "dependency",
    name: n,
    detector: `dependency-${file.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "")}`.slice(0, 64),
    reason: `declared in ${section} of ${file}`,
  };
  const v = version === undefined ? undefined : cleanToken(version);
  if (v && SAFE_VERSION.test(v)) f.value = v; // a URL, host or user:secret is not a version: keep the dependency, drop the value
  return f;
}

function jsonDeps(file: string, text: string, sections: string[]): RawFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const out: RawFinding[] = [];
  if (!doc || typeof doc !== "object") return out;
  for (const s of sections) {
    const m = (doc as Record<string, unknown>)[s];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      const f = dep(file, k, typeof v === "string" ? v : undefined, s);
      if (f) out.push(f);
    }
  }
  return out;
}

const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,100})\s*(?:\[[^\]]{0,100}\])?\s*((?:===|==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]{1,40})?/;

function requirement(file: string, spec: string, section: string): RawFinding | undefined {
  const m = ex(PEP508, spec);
  return m ? dep(file, m[1], m[2]?.replace(/\s+/g, ""), section) : undefined;
}

function tomlDeps(file: string, ls: string[]): RawFinding[] {
  const out: RawFinding[] = [];
  let section = "";
  let array = false;
  for (const raw of ls) {
    const l = raw.trim();
    if (array) {
      if (l.startsWith("]")) array = false;
      const q = ex(/^["']([^"']{1,200})["']/, l);
      if (q) {
        const f = requirement(file, q[1], section);
        if (f) out.push(f);
      }
      if (l.includes("]") && !l.startsWith("]")) array = false;
      continue;
    }
    const sec = ex(/^\[([^\]]{1,100})\]$/, l);
    if (sec) {
      section = sec[1].trim();
      const named = ex(/^(?:dependencies|dev-dependencies|build-dependencies|tool\.poetry\.dependencies|tool\.poetry\.group\.[\w-]+\.dependencies)\.([\w.-]+)$/, section);
      if (named) {
        const f = dep(file, named[1], undefined, section.slice(0, section.length - named[1].length - 1));
        if (f) out.push(f);
      }
      continue;
    }
    if (/^(?:dependencies|dev-dependencies|build-dependencies|tool\.poetry\.dependencies|tool\.poetry\.group\.[\w-]+\.dependencies)$/.test(section)) {
      const kv = ex(/^([A-Za-z0-9_.-]{1,100})\s*=\s*(.*)$/, l);
      if (kv && kv[1] !== "python") {
        const ver = ex(/^["']([^"']{1,60})["']/, kv[2]) ?? ex(/\bversion\s*=\s*["']([^"']{1,60})["']/, kv[2]);
        const f = dep(file, kv[1], ver?.[1], section);
        if (f) out.push(f);
      }
    } else if (section === "project" || section === "project.optional-dependencies" || section === "dependency-groups") {
      const start = ex(/^(?:dependencies|[\w-]+)\s*=\s*\[(.*)$/, l);
      if (start && (section !== "project" || l.startsWith("dependencies"))) {
        const rest = start[1];
        for (const q of rest.matchAll(/["']([^"']{1,200})["']/g)) {
          const f = requirement(file, q[1] ?? "", section);
          if (f) out.push(f);
        }
        array =!rest.includes("]");
      }
    }
  }
  return out;
}

function goDeps(file: string, ls: string[]): RawFinding[] {
  const out: RawFinding[] = [];
  let block = false;
  for (const raw of ls) {
    const l = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(l)) block = true;
    else if (block && l === ")") block = false;
    else {
      const m = ex(block ? /^(\S+)\s+(\S+)$/ : /^require\s+(\S+)\s+(\S+)$/, l);
      const f = m && dep(file, m[1], m[2], "require");
      if (f) out.push(f);
    }
  }
  return out;
}

function pomDeps(file: string, ls: string[]): RawFinding[] {
  const out: RawFinding[] = [];
  let cur: { g?: string; a?: string; v?: string } | undefined;
  for (const l of ls) {
    if (l.includes("<dependency>")) cur = {};
    if (cur) {
      const g = ex(/<groupId>([^<]{1,100})<\/groupId>/, l);
      const a = ex(/<artifactId>([^<]{1,100})<\/artifactId>/, l);
      const v = ex(/<version>([^<]{1,60})<\/version>/, l);
      if (g) cur.g = g[1].trim();
      if (a) cur.a = a[1].trim();
      if (v) cur.v = v[1].trim();
    }
    if (cur && l.includes("</dependency>")) {
      const f = cur.a ? dep(file, cur.g ? `${cur.g}:${cur.a}` : cur.a, cur.v, "dependencies") : undefined;
      if (f) out.push(f);
      cur = undefined;
    }
  }
  return out;
}

const GRADLE = /^\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|classpath)\s*\(?\s*["']([^"']{1,200})["']/;

/** Dependencies declared in one manifest file; [] for an unknown or malformed file. Never throws. */
export function dependenciesIn(relPath: string, text: string): RawFinding[] {
  try {
    const b = baseName(relPath);
    let out: RawFinding[] = [];
    if (b === "package.json") out = jsonDeps(b, text, ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);
    else if (b === "composer.json") out = jsonDeps(b, text, ["require", "require-dev"]);
    else if (b === "go.mod") out = goDeps(b, lines(text));
    else if (b === "Cargo.toml" || b === "pyproject.toml") out = tomlDeps(b, lines(text));
    else if (/^requirements[\w.-]*\.txt$/.test(b)) {
      for (const l of lines(text)) {
        if (/^\s*(?:#|-)/.test(l)) continue;
        const f = requirement(b, l, "requirements");
        if (f) out.push(f);
      }
    } else if (b === "pom.xml") out = pomDeps(b, lines(text));
    else if (b === "build.gradle" || b === "build.gradle.kts") {
      for (const l of lines(text)) {
        const m = ex(GRADLE, l);
        if (!m) continue;
        const [g, a, v] = m[1].split(":");
        const f = a ? dep(b, `${g}:${a}`, v, "dependencies") : undefined;
        if (f) out.push(f);
      }
    } else if (b === "Gemfile") {
      for (const l of lines(text)) {
        const m = ex(/^\s*gem\s+["']([^"']{1,100})["'](?:\s*,\s*["']([^"']{1,40})["'])?/, l);
        const f = m && dep(b, m[1], m[2], "gems");
        if (f) out.push(f);
      }
    }
    return out.slice(0, MAX_DEPS);
  } catch {
    return [];
  }
}

const JS_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const PY_STD = new Set(
  ("abc argparse ast asyncio base64 collections contextlib copy csv dataclasses datetime decimal enum functools glob hashlib heapq http " +
    "importlib inspect io itertools json logging math multiprocessing os pathlib pickle platform queue random re secrets shutil signal " +
    "socket sqlite3 ssl string struct subprocess sys tempfile textwrap threading time traceback types typing unittest urllib uuid warnings " +
    "weakref xml zipfile __future__").split(" "),
);
const RUST_SKIP = new Set(["crate", "self", "super", "std", "core", "alloc"]);

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.split("/")[0] ?? m));

const jsRoot =(spec: string): string | undefined => {
  if (/^(?:\.|\/|node:|#|https?:)/.test(spec)) return undefined;
  const parts = spec.split("/");
  if (!spec.startsWith("@") && NODE_BUILTINS.has(parts[0] ?? "")) return undefined;
  return spec.startsWith("@") ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
};

/** Import roots observed in one source file, e.g. { ecosystem: "npm", module: "@scope/pkg" }. Relative and standard-library roots are left out. */
export function importsIn(relPath: string, text: string): { ecosystem: string; module: string }[] {
  const found = new Map<string, { ecosystem: string; module: string }>();
  const add = (ecosystem: string, module: string | undefined) => {
    const m = module && cleanToken(module);
    if (m) found.set(`${ecosystem}\0${m}`, { ecosystem, module: m });
  };
  try {
    const ls = lines(text);
    if (JS_EXT.test(relPath)) {
      for (const l of ls) {
        const m =
          ex(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]{0,200}?\s+from\s+)?['"]([^'"]{1,200})['"]/, l) ??
          ex(/^\s*\}\s*from\s+['"]([^'"]{1,200})['"]/, l) ??
          ex(/\b(?:require|import)\(\s*['"]([^'"]{1,200})['"]\s*\)/, l);
        if (m) add("npm", jsRoot(m[1]));
      }
    } else if (relPath.endsWith(".py")) {
      for (const l of ls) {
        const f = ex(/^\s*from\s+([A-Za-z_][\w]{0,100})(?:\.[\w.]{0,100})?\s+import\b/, l);
        if (f) {
          if (!PY_STD.has(f[1])) add("python", f[1]);
          continue;
        }
        const i = ex(/^\s*import\s+([A-Za-z_][\w., ]{0,200})/, l);
        if (i) {
          for (const part of i[1].split(",")) {
            const root = ex(/^\s*([A-Za-z_]\w*)/, part)?.[1];
            if (root && !PY_STD.has(root)) add("python", root);
          }
        }
      }
    } else if (relPath.endsWith(".go")) {
      let block = false;
      for (const l of ls) {
        let m: Match | null = null;
        if (/^\s*import\s*\($/.test(l)) block = true;
        else if (block && /^\s*\)/.test(l)) block = false;
        else m = ex(block ? /^\s*(?:[\w.]+\s+)?"([^"]{1,200})"/ : /^\s*import\s+(?:[\w.]+\s+)?"([^"]{1,200})"/, l);
        if (!m) continue;
        const seg = m[1].split("/");
        const host = seg[0] ?? "";
        if (!host.includes(".")) continue;
        add("go", seg.slice(0, /^(?:github\.com|gitlab\.com|bitbucket\.org)$/.test(host) ? 3 : 2).join("/"));
      }
    } else if (/\.(?:java|kt|kts)$/.test(relPath)) {
      for (const l of ls) {
        const m = ex(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]{0,200})/, l);
        if (!m || /^(?:java|javax|jdk|sun|kotlin)\./.test(m[1])) continue;
        const seg = m[1].split(".");
        if (seg.length > 1) add("jvm", seg.slice(0, Math.min(3, seg.length - 1)).join("."));
      }
    } else if (relPath.endsWith(".rs")) {
      for (const l of ls) {
        const m = ex(/^\s*(?:pub\s+)?use\s+([A-Za-z_]\w*)::/, l) ?? ex(/^\s*extern\s+crate\s+([A-Za-z_]\w*)/, l);
        if (m && !RUST_SKIP.has(m[1])) add("rust", m[1]);
      }
    }
  } catch {
    /* no findings */
  }
  return [...found.values()];
}

const NO_TEST = /no test specified/;

function cmd(name: string, value: string | undefined, detector: string, reason: string, path: string): RawFinding {
  const f: RawFinding = { kind: "command", name, detector, reason, path };
  // A command that carries a URL, address or credential is kept without its text.
  const v = value === undefined || /:\/\/|@/.test(value) ? undefined : cleanToken(value, true);
  if (v) f.value = v;
  return f;
}

/**
 * Test, lint and build commands configured in one folder. `dir` is the folder ("" for the root); `files` maps
 * repository-relative paths (in that folder, plus `.claude-factory/config.yaml` for the root) to their text,
 * or to undefined when the file is present but was not read. Each finding names its source file in `path`.
 */
export function commandsIn(dir: string, files: ReadonlyMap<string, string | undefined>): RawFinding[] {
  const out: RawFinding[] = [];
  try {
    const at = (name: string) => (dir ? `${dir}/${name}` : name);
    const text = (name: string) => files.get(at(name));
    const has = (name: string) => files.has(at(name));
    const pinned = new Set<string>();

    const cfgPath = ".claude-factory/config.yaml";
    const cfg = dir === "" ? files.get(cfgPath) : undefined;
    if (cfg !== undefined) {
      const doc = parseYaml(cfg, { maxAliasCount: 0 }) as { vars?: Record<string, unknown> } | null;
      const vars = doc && typeof doc === "object" && doc.vars && typeof doc.vars === "object" ? doc.vars : {};
      for (const name of ["test", "lint", "build"]) {
        const v = (vars as Record<string, unknown>)[`${name}_cmd`];
        if (typeof v !== "string" || v.trim() === "" || v.trim() === "auto") continue;
        pinned.add(name);
        out.push(cmd(name, v, "command-config", "pinned in .claude-factory/config.yaml", cfgPath));
      }
    }
    const add = (name: string, value: string, detector: string, reason: string, file: string) => {
      if (!pinned.has(name)) out.push(cmd(name, value, detector, reason, at(file)));
    };

    const pkg = text("package.json");
    if (pkg !== undefined) {
      let scripts: Record<string, unknown> = {};
      try {
        const doc = JSON.parse(pkg) as { scripts?: Record<string, unknown> };
        if (doc?.scripts && typeof doc.scripts === "object") scripts = doc.scripts;
      } catch {
        /* none */
      }
      const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
      for (const name of ["test", "lint", "build"]) {
        const body = scripts[name];
        if (typeof body !== "string" || body.trim() === "" || NO_TEST.test(body)) continue;
        add(name, name === "test" ? `${pm} test` : `${pm} run ${name}`, "command-package-json", "script in package.json", "package.json");
      }
    }
    if (has("go.mod")) {
      add("test", "go test ./...", "command-go", "go.mod present", "go.mod");
      add("build", "go build ./...", "command-go", "go.mod present", "go.mod");
    }
    if (has("Cargo.toml")) {
      add("test", "cargo test", "command-cargo", "Cargo.toml present", "Cargo.toml");
      add("build", "cargo build", "command-cargo", "Cargo.toml present", "Cargo.toml");
    }
    const py = text("pyproject.toml");
    if (py !== undefined) {
      if (/\bpytest\b/.test(py)) add("test", "pytest", "command-python", "pytest mentioned in pyproject.toml", "pyproject.toml");
      if (/\bruff\b/.test(py)) add("lint", "ruff check", "command-python", "ruff mentioned in pyproject.toml", "pyproject.toml");
    }
    if (has("gradlew")) {
      add("test", "./gradlew test", "command-gradle", "gradlew present", "gradlew");
      add("build", "./gradlew build", "command-gradle", "gradlew present", "gradlew");
    }
    if (has("pom.xml")) {
      add("test", "mvn test", "command-maven", "pom.xml present", "pom.xml");
      add("build", "mvn package", "command-maven", "pom.xml present", "pom.xml");
    }
    const mk = text("Makefile");
    if (mk !== undefined) {
      for (const name of ["test", "lint", "build"]) {
        if (new RegExp(`^${name}\\s*:`, "m").test(mk)) add(name, `make ${name}`, "command-make", `${name} target in Makefile`, "Makefile");
      }
    }
  } catch {
    /* keep what was found */
  }
  return out;
}
