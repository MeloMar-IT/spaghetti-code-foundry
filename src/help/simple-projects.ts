import { guardExcerpt, type GuardOptions } from "./guard.js";
import { SIMPLE_ID_SHAPE, SIMPLE_NAME_MAX, SIMPLE_PROJECTS_MAX, type SimpleProject } from "./simple.js";

/**
 * The projects a Simple prompt may name: at most `SIMPLE_PROJECTS_MAX`, a plain id, and a name that passed the
 * guard unchanged. A name the guard withholds or changes (a secret, text that reads like an order) becomes
 * "a project". The names are the owner's own text: they are data in the prompt, never rules.
 */
export function simpleProjects(list: readonly SimpleProject[], guard: GuardOptions): SimpleProject[] {
  const out: SimpleProject[] = [];
  for (const p of list) {
    if (out.length >= SIMPLE_PROJECTS_MAX) break;
    if (typeof p.id !== "string" || !SIMPLE_ID_SHAPE.test(p.id)) continue;
    const name = String(p.name ?? "").slice(0, SIMPLE_NAME_MAX);
    const g = guardExcerpt(name, guard);
    out.push({ id: p.id, name: !g.withheld && g.text === name && name.trim() ? name : "a project" });
  }
  return out;
}
