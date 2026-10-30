import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readlinkSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { dataHome } from "./auth/store.js";
import { sha256Hex } from "./evidence/identity.js";
import type { Flow } from "./flow/schema.js";
import { canonicalJson } from "./policy/evaluate.js";
import { COMPONENT_KINDS, flowSha256, flowVersion, isCounted, lookupVersions } from "./promotion/components.js";
import { readHomeComponents } from "./promotion/home.js";
import { readVersionBook } from "./promotion/versions.js";
import type { Suite } from "./evals.js";

/**
 * What an eval report records about the things it ran against (#640): the suite, the fixtures, the flows that ran, the
 * cases and models, and every component of the Foundry home when the eval started. Only types are taken from evals.ts,
 * so the two modules do not import each other at run time.
 */

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const EvalInputsSchema = z.object({
  version: z.literal(1),
  live: z.boolean(),
  suite: z.object({ sha256: Sha }),
  fixtures: z.array(z.object({ repo: z.string(), sha256: Sha.nullable() })),
  flows: z.array(z.object({ entry: z.string(), kind: z.literal("flow"), id: z.string(), version: z.string(), sha256: Sha })),
  cases: z.array(z.string()),
  models: z.array(z.string()).optional(),
  components: z.array(z.object({ kind: z.enum(COMPONENT_KINDS), id: z.string(), version: z.string().optional(), sha256: Sha, builtin: z.literal(true).optional() })),
});

export type EvalInputs = z.infer<typeof EvalInputsSchema>;
export type EvalFlowInput = EvalInputs["flows"][number];
export type EvalComponentInput = EvalInputs["components"][number];
/** The part of the inputs that comes from the suite file and its folders. */
export type SuiteInputs = Omit<EvalInputs, "version" | "live" | "components">;

const SKIPPED = new Set([".git", ".DS_Store"]);

function walk(h: ReturnType<typeof createHash>, dir: string, prefix: string): void {
  const put = (tag: string, text: string | Buffer) => {
    const b = typeof text === "string" ? Buffer.from(text) : text;
    h.update(`${tag}:${b.length}:`);
    h.update(b);
  };
  for (const name of readdirSync(dir).filter((n) => !SKIPPED.has(n)).sort()) {
    const path = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      put("l", rel);
      put("t", readlinkSync(path));
    } else if (st.isDirectory()) {
      put("d", rel);
      walk(h, path, rel);
    } else if (st.isFile()) {
      put("f", rel);
      put("c", readFileSync(path));
    }
  }
}

/** The hash of a plain folder: sorted paths and contents, length-prefixed. `.git` and `.DS_Store` are skipped. Undefined when it is missing or not a folder. */
export function folderSha256(dir: string): string | undefined {
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    const h = createHash("sha256");
    walk(h, dir, "");
    return h.digest("hex");
  } catch {
    return undefined;
  }
}

/** The hash of a case repo spec: a plain folder next to the suite. A URL, a folder with `.git` or a missing folder is not hashed. */
function fixtureHash(spec: string, suiteDir: string): string | null {
  if (/^(https?:|git@|ssh:)/.test(spec)) return null;
  const dir = resolve(suiteDir, spec);
  if (existsSync(join(dir, ".git"))) return null;
  return folderSha256(dir) ?? null;
}

/** The inputs that come from the suite: the parsed suite (comments and key order do not count), its fixtures, and the flows that ran. */
export function suiteInputs(suite: Suite, suiteDir: string, flows: readonly { entry: string; flow: Flow }[], cases: readonly string[], models?: readonly string[]): SuiteInputs {
  const specs: string[] = [];
  for (const name of cases) {
    const c = suite.cases.find((x) => x.name === name);
    if (c && !specs.includes(c.repo)) specs.push(c.repo);
  }
  return {
    suite: { sha256: sha256Hex(canonicalJson(suite)) },
    fixtures: specs.map((repo) => ({ repo, sha256: fixtureHash(repo, suiteDir) })),
    flows: flows.map(({ entry, flow }) => ({ entry, kind: "flow" as const, id: flow.name, version: flowVersion(flow), sha256: flowSha256(flow) })),
    cases: [...cases],
    ...(models?.length ? { models: [...models] } : {}),
  };
}

/** Every component of the home folder, with its recorded version for the counted kinds. A component that cannot be read is left out. */
export function homeInputs(home = dataHome()): EvalComponentInput[] {
  const { found } = readHomeComponents(home);
  const counted = found.filter((f): f is typeof f & { kind: "tool-profile" | "model-routes" | "context-selector" } => isCounted(f.kind));
  const book = counted.length ? readVersionBook(home) : undefined;
  const versions = book?.ok ? lookupVersions(book.book, counted.map((f) => ({ kind: f.kind, id: f.id, sha256: f.sha256 }))) : [];
  return found.map((f) => {
    const v = isCounted(f.kind) ? versions[counted.indexOf(f as (typeof counted)[number])] : undefined;
    const version = f.version ?? (v === undefined ? undefined : String(v));
    return { kind: f.kind, id: f.id, ...(version === undefined ? {} : { version }), sha256: f.sha256, ...(f.builtin ? { builtin: true as const } : {}) };
  });
}

/** A suite is live when no fake `claude` stands in for the model: neither the suite names one nor was one given. */
export const evalLive = (suite: Pick<Suite, "programs">, claudeBin?: string): boolean => !suite.programs?.claude && !claudeBin;

export type InputMismatch = { code: "report-invalid" | "report-stale"; detail: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The first difference between what a report recorded and what is there now: the suite, then the cases, flow entries and models (partial), then fixtures, then flows. */
export function compareInputs(recorded: SuiteInputs, current: SuiteInputs): InputMismatch | undefined {
  if (recorded.suite.sha256 !== current.suite.sha256) return { code: "report-stale", detail: "suite" };
  if (!same(recorded.cases, current.cases) || !same(recorded.flows.map((f) => f.entry), current.flows.map((f) => f.entry)) || !same(recorded.models, current.models)) {
    return { code: "report-invalid", detail: "partial" };
  }
  for (const f of current.fixtures) {
    const r = recorded.fixtures.find((x) => x.repo === f.repo);
    if (!r || r.sha256 !== f.sha256) return { code: "report-stale", detail: `fixture ${f.repo}` };
  }
  for (const f of current.flows) {
    const r = recorded.flows.find((x) => x.entry === f.entry);
    if (!r || r.sha256 !== f.sha256) return { code: "report-stale", detail: `flow ${f.id}` };
  }
  return undefined;
}

/** `variant|case|attempt` of every result a complete run holds: flows × models × cases × repeat. */
export function expectedResultKeys(suite: Pick<Suite, "repeat">, inputs: SuiteInputs): string[] {
  const keys: string[] = [];
  for (const f of inputs.flows) {
    for (const variant of inputs.models?.length ? inputs.models.map((m) => `${f.id}@${m}`) : [f.id]) {
      for (const c of inputs.cases) for (let a = 1; a <= suite.repeat; a++) keys.push(`${variant}|${c}|${a}`);
    }
  }
  return keys;
}
