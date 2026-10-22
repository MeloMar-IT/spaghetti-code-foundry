import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { extname, basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { loadConfig } from "../config.js";
import { ContextSelectorSettingsSchema } from "../context/select.js";
import { MAX_PACK_BYTES, POLICY_FOLDER, readPolicyFile } from "../engine/policy-hooks.js";
import { PolicyIdentitySchema } from "../evidence/identity.js";
import { FlowParseError, flowDir, parseFlow } from "../flow/load.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../policy/baseline.js";
import { policyPackSha256 } from "../policy/evaluate.js";
import { parsePolicyPack } from "../policy/parse.js";
import { PolicySchemaError } from "../policy/version.js";
import { parseToolProfile } from "../tool-profile/parse.js";
import { toolProfileSha256 } from "../tool-profile/resolve.js";
import { ToolProfileSchemaError } from "../tool-profile/version.js";
import { COMPONENT_ID_RE, COMPONENT_KINDS, contextSelectorSha256, flowSha256, flowVersion, MODEL_ROUTES_ID, modelRoutesSha256, type ComponentKind } from "./components.js";

/**
 * Reads the components in the Foundry home folder. Never writes. A file that cannot be used gives a problem and never
 * stops the others. A reason is fixed text or the place and rule of the first wrong field: never a machine path, a
 * line of the file or a value from it.
 */

export const TOOL_PROFILE_FOLDER = "tool-profiles";
export const CONTEXT_SELECTOR_FOLDER = "context-selectors";

export interface FoundComponent {
  kind: ComponentKind;
  id: string;
  sha256: string;
  /** Unset for the counted kinds. */
  version?: string;
  builtin?: boolean;
}
export interface ComponentProblem {
  kind: ComponentKind;
  id: string;
  reason: string;
}
export interface HomeComponents {
  found: FoundComponent[];
  problems: ComponentProblem[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Names under which a key of the file's own choosing follows: the path stops there. */
const USER_KEYED = new Set(["vars", "var_info", "descriptions", "env", "inputs", "with"]);

const FIXED_MESSAGES = new Set(["names a tool the profile does not grant"]);

/** `path: message` of one wrong field, with nothing the author typed except the names of fields of the schema. */
function safeIssue(path: readonly (string | number)[], message: string): string {
  const parts: string[] = [];
  for (const p of path) {
    if (typeof p === "number") parts.push(String(p));
    else if (/^[a-zA-Z][a-zA-Z_]{0,30}$/.test(p)) parts.push(p);
    else break;
    if (typeof p === "string" && USER_KEYED.has(p)) break;
  }
  // A schema message may repeat a value of the file (a default, a choice, a step id): only these fixed ones are printed.
  const text = /^Unrecognized key/i.test(message) ? "unknown field" : FIXED_MESSAGES.has(message) ? message : "is not valid";
  return `${parts.join(".") || "(root)"}: ${text}`;
}

const issuePath = (p: string): (string | number)[] => (p === "(root)" ? [] : p.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s)));

/** An error whose message is fixed text, safe to print. */
class Reason extends Error {}

function reasonOf(e: unknown): string {
  if (e instanceof Reason) return e.message;
  if (e instanceof FlowParseError) return e.issues[0] ? safeIssue(e.issues[0].path, e.issues[0].message) : "is not valid YAML";
  if (e instanceof ToolProfileSchemaError || e instanceof PolicySchemaError) {
    if (e.code === "not-an-object") return "is not an object";
    if (e.code === "no-version") return "has no version";
    if (e.code === "unsupported-version") return "has a version this Foundry cannot read";
    const i = e.issues[0];
    return i ? safeIssue(issuePath(i.path), i.message) : "is not valid";
  }
  if (e instanceof ZodError) {
    const i = e.issues[0]!;
    return safeIssue(i.path.filter((p): p is string | number => typeof p !== "symbol"), i.code === "unrecognized_keys" ? "Unrecognized key" : i.message);
  }
  return "could not be read";
}

const readProblem = (p: "missing" | "not-file" | "too-large" | "unreadable"): string =>
  p === "not-file" ? "is not a plain file" : p === "too-large" ? "is larger than 1 MiB" : "could not be read";

/** The files of a home folder with one of these extensions: sorted, no dotfiles. A missing folder is empty; a link is a problem. */
function listFolder(dir: string, exts: readonly string[], follow = false): { files: Dirent[] } | { problem: string } {
  try {
    if (!follow && !lstatSync(dir).isDirectory()) return { problem: "is a link or not a folder" };
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") && !d.isDirectory() && exts.includes(extname(d.name)))
      .sort((a, b) => byText(a.name, b.name));
    return { files };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { files: [] } : { problem: "could not be read" };
  }
}

export function readHomeComponents(home: string, o: { kinds?: readonly ComponentKind[]; builtinFlowsDir?: string } = {}): HomeComponents {
  const found: FoundComponent[] = [];
  const problems: ComponentProblem[] = [];
  const want = (k: ComponentKind) => (o.kinds ?? COMPONENT_KINDS).includes(k);
  const problem = (kind: ComponentKind, id: string, reason: string): void => void problems.push({ kind, id, reason });

  /** One file in its own try/catch: `use` gets the text and returns the component. */
  const each = (kind: ComponentKind, dir: string, d: Dirent, id: string, use: (text: string) => FoundComponent): void => {
    try {
      const read = readPolicyFile(join(dir, d.name), MAX_PACK_BYTES);
      if ("problem" in read) return problem(kind, id, readProblem(read.problem));
      found.push(use(read.text));
    } catch (e) {
      problem(kind, id, reasonOf(e));
    }
  };
  const folder = (kind: ComponentKind, dir: string, exts: readonly string[], follow = false): Dirent[] => {
    const l = listFolder(dir, exts, follow);
    if ("problem" in l) {
      problem(kind, `(${basename(dir)})`, l.problem);
      return [];
    }
    return l.files;
  };
  const yamlDoc = (text: string): unknown => {
    try {
      return parseYaml(text);
    } catch {
      throw new Reason("is not valid YAML");
    }
  };

  if (want("flow")) {
    const scan = (dir: string, builtin: boolean, follow: boolean) => {
      const seen = new Set<string>();
      for (const d of folder("flow", dir, [".yaml", ".yml"], follow)) {
        const id = basename(d.name, extname(d.name));
        if (seen.has(id)) continue;
        seen.add(id);
        each("flow", dir, d, id, (text) => {
          const flow = parseFlow(text, `flows/${d.name}`);
          return { kind: "flow", id, version: flowVersion(flow), sha256: flowSha256(flow), ...(builtin ? { builtin: true } : {}) };
        });
      }
    };
    scan(join(home, "flows"), false, false);
    scan(o.builtinFlowsDir ?? flowDir("builtin", ""), true, true);
  }

  if (want("policy-pack")) {
    const dir = join(home, POLICY_FOLDER);
    for (const d of folder("policy-pack", dir, [".json"])) {
      const id = basename(d.name, ".json");
      if (!PolicyIdentitySchema.shape.id.safeParse(id).success || id === BASELINE_POLICY_ID) continue;
      each("policy-pack", dir, d, id, (text) => {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new Reason("is not valid JSON");
        }
        const pack = parsePolicyPack(raw);
        if (pack.policy.id !== id) throw new Reason("id differs from the file name");
        return { kind: "policy-pack", id, version: pack.policy.version, sha256: policyPackSha256(pack) };
      });
    }
    found.push({ kind: "policy-pack", id: BASELINE_POLICY_ID, version: BASELINE_PACK.policy.version, sha256: policyPackSha256(BASELINE_PACK), builtin: true });
  }

  if (want("tool-profile")) {
    const dir = join(home, TOOL_PROFILE_FOLDER);
    for (const d of folder("tool-profile", dir, [".yaml"])) {
      const id = basename(d.name, ".yaml");
      if (!COMPONENT_ID_RE.test(id)) {
        problem("tool-profile", "(file)", "the file name is not a profile id: lower-case letters, digits, . _ or -");
        continue;
      }
      each("tool-profile", dir, d, id, (text) => {
        const profile = parseToolProfile(yamlDoc(text));
        if (profile.profile.id !== id) throw new Reason("profile id differs from the file name");
        return { kind: "tool-profile", id, sha256: toolProfileSha256(profile) };
      });
    }
  }

  if (want("model-routes")) {
    try {
      found.push({ kind: "model-routes", id: MODEL_ROUTES_ID, sha256: modelRoutesSha256(loadConfig(join(home, "config.yaml")).router) });
    } catch {
      problem("model-routes", MODEL_ROUTES_ID, "config.yaml could not be read or is not valid");
    }
  }

  if (want("context-selector")) {
    const dir = join(home, CONTEXT_SELECTOR_FOLDER);
    for (const d of folder("context-selector", dir, [".yaml"])) {
      const id = basename(d.name, ".yaml");
      if (!COMPONENT_ID_RE.test(id)) {
        problem("context-selector", "(file)", "the file name is not a selector id: lower-case letters, digits, . _ or -");
        continue;
      }
      each("context-selector", dir, d, id, (text) => {
        const res = ContextSelectorSettingsSchema.safeParse(yamlDoc(text));
        if (!res.success) throw res.error;
        return { kind: "context-selector", id, sha256: contextSelectorSha256(res.data) };
      });
    }
  }

  return { found, problems };
}
