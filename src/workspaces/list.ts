import { z } from "zod";

/**
 * Workspaces (#816): the schema of the list and the slot for the one plugin that supplies it. This file imports only zod,
 * so config.ts, usage/schema.ts and plugins/load.ts can use it without an import cycle.
 */

export const DEFAULT_WORKSPACE = "default";
export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const validWorkspaceId = (v: unknown): v is string => typeof v === "string" && WORKSPACE_ID_RE.test(v);

export const WorkspaceLimitsSchema = z
  .object({
    max_concurrent: z.number().int().min(1).max(1000).optional(),
    test_slots: z.number().int().min(1).max(100).optional(),
    monthly_budget_usd: z.number().positive().finite().optional(),
  })
  .strict();

/** A host a team's steps may reach (#785): a name, or `*.domain` for its subdomains, with an optional port (443 when absent). IP literals are refused. */
export const HostEntry = z
  .string()
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[1-9][0-9]{0,4})?$/)
  .refine((v) => {
    const m = /:(\d+)$/.exec(v);
    return !m || Number(m[1]) <= 65535;
  }, { message: "a port is 1 to 65535" })
  .refine((v) => !/^\d+$/.test(v.replace(/:\d+$/, "").split(".").pop() ?? ""), { message: "an IP address is not a host name" });

export const WorkspaceSchema = z
  .object({
    id: z
      .string()
      .regex(WORKSPACE_ID_RE)
      .refine((v) => v !== DEFAULT_WORKSPACE, { message: '"default" is reserved' }),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      // eslint-disable-next-line no-control-regex
      .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: "no control characters" }),
    members: z
      .array(z.uuid())
      .max(1000)
      .refine((l) => new Set(l).size === l.length, { message: "a member is listed twice" })
      .default([]),
    limits: WorkspaceLimitsSchema.prefault({}),
    hosts: z.array(HostEntry).max(100).default([]),
  })
  .strict();

export const WorkspaceListSchema = z
  .array(WorkspaceSchema)
  .max(100)
  .superRefine((l, ctx) => {
    const seen = new Set<string>();
    for (const [i, w] of l.entries()) {
      if (seen.has(w.id)) ctx.addIssue({ code: "custom", message: "a workspace id is used twice", path: [i, "id"] });
      seen.add(w.id);
    }
  });

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceLimits = z.infer<typeof WorkspaceLimitsSchema>;
/** What a plugin gives `api.workspaces`. `list()` is synchronous and returns the whole list. */
export interface WorkspaceStore {
  list(): unknown;
}

interface Supplier {
  owner: string;
  plugin: string;
  store: WorkspaceStore;
  report: (reason: string) => void;
}
let supplier: Supplier | undefined;
let reportedReason: string | undefined;

export const REASON_LIST_THREW = "the workspace list() threw an error; every account is in the default workspace";
export const REASON_LIST_ASYNC = "the workspace list() returned a promise; it must return the list at once";
export const REASON_LIST_BAD = "the workspace list() returned a list that is not valid; every account is in the default workspace";

/** Takes the one supplier slot. */
export function supplyWorkspaces(s: Supplier): "ok" | { taken: string } {
  if (supplier) return { taken: supplier.plugin };
  supplier = s;
  reportedReason = undefined;
  return "ok";
}

export function disposeWorkspaces(owner: string): void {
  if (supplier?.owner === owner) {
    supplier = undefined;
    reportedReason = undefined;
  }
}

function problem(s: Supplier, reason: string): void {
  if (reportedReason === reason) return;
  reportedReason = reason;
  try {
    s.report(reason);
  } catch {
    /* a failing report must not reach the caller */
  }
}

/** undefined: there is no supplier. Never throws. */
export function suppliedWorkspaces(): { ok: true; list: Workspace[] } | { ok: false } | undefined {
  const s = supplier;
  if (!s) return undefined;
  let value: unknown;
  try {
    value = s.store.list();
  } catch {
    problem(s, REASON_LIST_THREW);
    return { ok: false };
  }
  try {
    if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
      try {
        (value as PromiseLike<unknown>).then(undefined, () => {});
      } catch {
        /* a thenable that throws */
      }
      problem(s, REASON_LIST_ASYNC);
      return { ok: false };
    }
  } catch {
    problem(s, REASON_LIST_ASYNC);
    return { ok: false };
  }
  const parsed = WorkspaceListSchema.safeParse(value);
  if (!parsed.success) {
    problem(s, REASON_LIST_BAD);
    return { ok: false };
  }
  reportedReason = undefined;
  return { ok: true, list: parsed.data };
}
