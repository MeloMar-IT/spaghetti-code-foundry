/**
 * JVM technology detectors for the repository profile: Spring Boot (parent, plugin, BOM), Java version, Maven and Gradle wrappers.
 * Pure: lines in, findings out, never throws. A value is kept only when it is a plain version; a name only when it is a plain coordinate.
 * Detector ids start with `technology-`, so the profile can tell these findings from the dependency findings that existed before.
 */
import type { RawFinding } from "./repo-profile-detect.js";
import { PLAIN_VERSION_RE, SPRING_NAME_RE, UNREADABLE_VERSION } from "./technology-rules.js";

const BOOT = "org.springframework.boot";
const COORD_PART = /^[A-Za-z0-9._-]{1,100}$/;

function finding(file: string, name: string, value: string | undefined, section: string): RawFinding {
  const f: RawFinding = {
    kind: "dependency",
    name,
    detector: `technology-${file.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "")}`.slice(0, 64),
    reason: `declared in ${section} of ${file}`,
  };
  if (value !== undefined && (PLAIN_VERSION_RE.test(value) || value === UNREADABLE_VERSION)) f.value = value;
  return f;
}

const versionValue = (raw: string | undefined): string | undefined => (raw !== undefined && PLAIN_VERSION_RE.test(raw) ? raw : unreadable(raw));

/** The value of a technology whose version is declared but cannot be read (`${boot.version}`, `3.+`): it ends inheritance from a parent build. */
const unreadable = (raw: string | undefined): string | undefined => (raw !== undefined && !PLAIN_VERSION_RE.test(raw) ? UNREADABLE_VERSION : undefined);

/** Drops the value of a Spring dependency that is not a plain version (`latest`, `3.+`, `^3.2`). Other findings are returned as they are. */
export function strictJvmValue(f: RawFinding): RawFinding {
  if (f.value === undefined || !SPRING_NAME_RE.test(f.name) || PLAIN_VERSION_RE.test(f.value)) return f;
  const { value: _dropped, ...rest } = f;
  return rest;
}

const tag = (name: string) => new RegExp(`<${name.replace(/\./g, "\\.")}>\\s*([^<\\s]{1,60})\\s*</${name.replace(/\./g, "\\.")}>`);
const JAVA_PROPS = ["java.version", "maven.compiler.release", "maven.compiler.source"].map((n) => ({ n, re: tag(n) }));

/** Spring Boot from `<parent>` and `<plugin>`, and the Java version from the properties of a pom.xml. */
export function pomTechnologies(file: string, ls: readonly string[]): RawFinding[] {
  try {
    const out: RawFinding[] = [];
    const blocks: { section: string; v?: string }[] = [];
    // Comments are not declarations, also when they span lines.
    const text = ls.join("\n").replace(/<!--[\s\S]*?-->/g, "").replace(/<!--[\s\S]*$/, "");
    let cur: { section: string; name: string; depth: number; g?: string; v?: string } | undefined;
    const props = new Map<string, string>();
    for (const l of text.split("\n")) {
      for (const p of JAVA_PROPS) {
        const m = p.re.exec(l);
        if (m && !props.has(p.n)) props.set(p.n, m[1]!);
      }
      for (const t of l.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^<>]*?(\/?)>([^<]*)/g)) {
        const [, closing, name, selfClosing, after] = t as unknown as [string, string, string, string, string];
        if (!cur) {
          if (!closing && !selfClosing && (name === "parent" || name === "plugin")) cur = { section: name === "parent" ? "parent" : "plugins", name, depth: 1 };
          continue;
        }
        if (selfClosing) continue;
        if (closing) {
          cur.depth--;
          if (cur.depth === 0) {
            if (cur.g === BOOT) blocks.push({ section: cur.section, ...(cur.v !== undefined ? { v: cur.v } : {}) });
            cur = undefined;
          }
          continue;
        }
        // Only the direct children of the block are its own; a nested dependency has its own groupId and version.
        if (cur.depth === 1 && name === "groupId" && cur.g === undefined) cur.g = after.trim();
        if (cur.depth === 1 && name === "version" && cur.v === undefined) cur.v = after.trim();
        cur.depth++;
      }
    }
    const readable = blocks.find((b) => b.v !== undefined && PLAIN_VERSION_RE.test(b.v));
    const boot = readable ?? blocks.find((b) => b.v !== undefined) ?? blocks[0];
    if (boot) out.push(finding(file, BOOT, readable ? readable.v : unreadable(boot.v), boot.section));
    const declared = JAVA_PROPS.map((p) => props.get(p.n)).filter((v): v is string => v !== undefined);
    const java = declared.find((v) => PLAIN_VERSION_RE.test(v));
    if (java !== undefined) out.push(finding(file, "java", java, "properties"));
    else if (declared.length) out.push(finding(file, "java", UNREADABLE_VERSION, "properties"));
    return out;
  } catch {
    return [];
  }
}

const JAVA_TOOLCHAIN = /JavaLanguageVersion\.of\(\s*["']?(\d{1,2})["']?\s*\)/;
const JAVA_SOURCE = /\bsourceCompatibility\s*=?\s*(?:JavaVersion\.VERSION_(\d{1,2}(?:_\d{1,2})?)|["']?(\d{1,2}(?:\.\d{1,2})?)["']?)\s*$/;
const BOOT_PLUGIN = /\bid\s*\(?\s*["']org\.springframework\.boot["']\)?(?:\s+version\s+["']([^"']{1,60})["'])?/;
const BOM = /^\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor|classpath)\s*\(?\s*(?:platform|enforcedPlatform)\s*\(\s*["']([^"':]{1,100}):([^"':]{1,100})(?::([^"']{1,60}))?["']\s*\)/;

/** Spring Boot (plugin or BOM), Spring Framework BOMs and the Java version of a build.gradle or build.gradle.kts. */
export function gradleTechnologies(file: string, ls: readonly string[]): RawFinding[] {
  try {
    let java: string | undefined;
    let boot: { v?: string; section: string } | undefined;
    const frameworks = new Map<string, RawFinding>();
    const setBoot = (v: string | undefined, section: string) => {
      const plain = v !== undefined && PLAIN_VERSION_RE.test(v);
      if (!boot || (plain && !PLAIN_VERSION_RE.test(boot.v ?? ""))) boot = { v: versionValue(v), section };
    };
    for (const l of ls) {
      if (l.trimStart().startsWith("//")) continue;
      if (java === undefined) {
        const t = JAVA_TOOLCHAIN.exec(l);
        const s = t ? undefined : JAVA_SOURCE.exec(l);
        java = t ? t[1] : s ? (s[1] ? s[1].replace("_", ".") : s[2]) : undefined;
      }
      const p = BOOT_PLUGIN.exec(l);
      if (p) setBoot(p[1], "plugins");
      const b = BOM.exec(l);
      if (!b) continue;
      const [, g, a, v] = b;
      if (!COORD_PART.test(g!) || !COORD_PART.test(a!)) continue;
      if (g === BOOT) setBoot(v, "platform");
      else if (g === "org.springframework" && !frameworks.has(a!)) frameworks.set(a!, finding(file, `${g}:${a}`, versionValue(v), "platform"));
    }
    const out: RawFinding[] = [];
    if (java !== undefined && PLAIN_VERSION_RE.test(java)) out.push(finding(file, "java", java, "toolchain"));
    if (boot) out.push(finding(file, BOOT, (boot as { v?: string }).v, (boot as { section: string }).section));
    out.push(...frameworks.values());
    return out;
  } catch {
    return [];
  }
}

const WRAPPER_URL = {
  "maven-wrapper.properties": { name: "maven", re: /apache-maven-(\d[0-9A-Za-z.-]{0,40}?)-bin\.(?:zip|tar\.gz)\s*$/ },
  "gradle-wrapper.properties": { name: "gradle", re: /gradle-(\d[0-9A-Za-z.-]{0,40}?)-(?:bin|all)\.zip\s*$/ },
} as const;

/** The Maven or Gradle version of a wrapper properties file, from `distributionUrl`. Only the version is kept, never the URL. */
export function wrapperTechnology(file: "maven-wrapper.properties" | "gradle-wrapper.properties", ls: readonly string[]): RawFinding[] {
  try {
    const rule = WRAPPER_URL[file];
    for (const l of ls) {
      const t = l.trimStart();
      if (t.startsWith("#") || !t.startsWith("distributionUrl")) continue;
      const m = rule.re.exec(l);
      if (m && PLAIN_VERSION_RE.test(m[1]!)) return [finding(file, rule.name, m[1], "distributionUrl")];
      return [];
    }
    return [];
  } catch {
    return [];
  }
}
