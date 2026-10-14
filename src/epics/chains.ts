// Epics: build order, dependency chains and the critical path. Pure: an epic's stories and the issue
// records in, chains out. The depends-on numbers come from the records; no issue text is read.
import type { IssueRecord } from "../queue/issue-list.js";
import type { EpicStory, StoryState } from "./model.js";

/** The words for a cycle group. */
export const CYCLE_WORDS = "depend on each other";

export interface ChainNode {
  issue: number; title: string; state: StoryState;
  done: boolean;
  /** Index in the build order. */
  order: number;
  /** 0 = depends on nothing in the epic. */
  level: number;
  /** Inside the epic, split originals already replaced by their parts; ascending. */
  dependsOn: number[];
  /** Named, not followed; ascending. */
  outside: number[];
  /** Index into `EpicChains.cycles`. */
  cycle?: number;
  /** On the critical path. */
  critical?: true;
}
/** `from` depends on `to`. */
export interface ChainEdge { from: number; to: number; critical?: true }
export interface OutsideStory { issue: number; title?: string }
export interface CriticalPath {
  /** In build order; may hold done stories in the middle. */
  stories: number[];
  /** Not-done stories on it. */
  remaining: number;
  /** The first not-done story on it. */
  at?: number;
}
export interface EpicChains {
  order: number[];
  nodes: ChainNode[];
  edges: ChainEdge[];
  outside: OutsideStory[];
  cycles: number[][];
  criticalPath: CriticalPath;
}

const asc = (a: number, b: number): number => a - b;

interface Resolved { deps: Map<number, number[]>; outside: Map<number, number[]> }

/** Resolve every dependency number of every node: edge, parts of a split original, outside, or ignored. */
function resolveDeps(nodes: Map<number, EpicStory>, all: Map<number, EpicStory>, byNumber: Map<number, IssueRecord>, records: readonly IssueRecord[]): Resolved {
  const partsOf = new Map<number, number[]>();
  for (const r of records) if (r.partOf !== undefined) (partsOf.get(r.partOf) ?? partsOf.set(r.partOf, []).get(r.partOf)!).push(r.number);
  const deps = new Map<number, number[]>(), outside = new Map<number, number[]>();

  for (const [s] of nodes) {
    const ancestors = new Set<number>();
    for (let cur = byNumber.get(s)?.partOf; cur !== undefined && !ancestors.has(cur); cur = byNumber.get(cur)?.partOf) ancestors.add(cur);
    const edges = new Set<number>(), out = new Set<number>();
    const seen = new Set<number>();
    const resolve = (d: number, viaSplit: boolean): void => {
      const st = all.get(d);
      if (st && st.state !== "split" && st.state !== "dropped") { if (d !== s) edges.add(d); return; }
      if (st?.state === "dropped") return;
      if (st?.state === "split") {
        // A part that depends on its own original must not wait for itself and its siblings.
        if (!viaSplit && ancestors.has(d)) return;
        if (seen.has(d)) return;
        seen.add(d);
        for (const p of partsOf.get(d) ?? []) resolve(p, true);
        return;
      }
      out.add(d); // outside the epic (also a part of a split original): named, not followed
    };
    for (const d of byNumber.get(s)?.dependsOn ?? []) resolve(d, false);
    deps.set(s, [...edges].sort(asc));
    outside.set(s, [...out].sort(asc));
  }
  return { deps, outside };
}

/** Strongly connected components, iterative Tarjan. Each component is ascending. */
function components(issues: number[], deps: Map<number, number[]>): number[][] {
  const index = new Map<number, number>(), low = new Map<number, number>();
  const onStack = new Set<number>(), stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;
  for (const root of issues) {
    if (index.has(root)) continue;
    const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const next = deps.get(frame.v) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      if (low.get(frame.v) === index.get(frame.v)) {
        const comp: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== frame.v);
        result.push(comp.sort(asc));
      }
    }
  }
  return result;
}

/** Kahn over the components: the ready one with the lowest issue number goes first. */
function orderComponents(comps: number[][], compOf: Map<number, number>, deps: Map<number, number[]>): { order: number[]; compDeps: number[][] } {
  const compDeps = comps.map((c, i) => {
    const s = new Set<number>();
    for (const v of c) for (const d of deps.get(v) ?? []) { const k = compOf.get(d)!; if (k !== i) s.add(k); }
    return [...s];
  });
  const waiting = compDeps.map((d) => d.length);
  const users: number[][] = comps.map(() => []);
  compDeps.forEach((ds, i) => ds.forEach((d) => users[d]!.push(i)));
  const ready: number[] = [];
  waiting.forEach((w, i) => { if (w === 0) ready.push(i); });
  const order: number[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (comps[ready[i]!]![0]! < comps[ready[best]!]![0]!) best = i;
    const c = ready.splice(best, 1)[0]!;
    order.push(c);
    for (const u of users[c]!) if (--waiting[u]! === 0) ready.push(u);
  }
  return { order, compDeps };
}

export function buildChains(stories: readonly EpicStory[], records: readonly IssueRecord[]): EpicChains {
  const all = new Map<number, EpicStory>();
  for (const s of stories) if (!all.has(s.issue)) all.set(s.issue, s);
  const nodes = new Map<number, EpicStory>();
  for (const [n, s] of all) if (s.state !== "split" && s.state !== "dropped") nodes.set(n, s);
  const byNumber = new Map<number, IssueRecord>();
  for (const r of records) byNumber.set(r.number, r);

  const { deps, outside } = resolveDeps(nodes, all, byNumber, records);
  const issues = [...nodes.keys()].sort(asc);
  const comps = components(issues, deps);
  comps.sort((a, b) => a[0]! - b[0]!);
  const compOf = new Map<number, number>();
  comps.forEach((c, i) => c.forEach((v) => compOf.set(v, i)));
  const { order: compOrder, compDeps } = orderComponents(comps, compOf, deps);

  const order: number[] = [];
  for (const c of compOrder) order.push(...comps[c]!);
  const orderOf = new Map<number, number>();
  order.forEach((n, i) => orderOf.set(n, i));

  // Levels, then the critical path, over the components in build order (dependencies come first).
  const level = new Map<number, number>(), best = new Map<number, number>(), prev = new Map<number, number>();
  const weight = (c: number) => comps[c]!.filter((v) => !isDone(v)).length;
  const isDone = (v: number) => nodes.get(v)!.state === "done";
  for (const c of compOrder) {
    let lv = 0, top = 0, from: number | undefined;
    for (const d of compDeps[c]!) {
      lv = Math.max(lv, level.get(d)! + 1);
      const b = best.get(d)!;
      if (b > top || (b === top && b > 0 && from !== undefined && comps[d]![0]! < comps[from]![0]!)) { top = b; from = d; }
    }
    level.set(c, lv);
    best.set(c, weight(c) + top);
    if (from !== undefined) prev.set(c, from);
  }
  let end: number | undefined;
  for (const c of compOrder) {
    if (weight(c) === 0) continue;
    if (end === undefined || best.get(c)! > best.get(end)! || (best.get(c) === best.get(end) && comps[c]![0]! < comps[end]![0]!)) end = c;
  }
  const pathComps: number[] = [];
  for (let c: number | undefined = end; c !== undefined; c = prev.get(c)) pathComps.push(c);
  pathComps.reverse();
  const pathStories = pathComps.flatMap((c) => comps[c]!);
  const onPath = new Set(pathStories);
  const posOf = new Map<number, number>();
  pathComps.forEach((c, i) => posOf.set(c, i));
  const notDone = pathStories.filter((v) => !isDone(v));
  const criticalPath: CriticalPath = { stories: pathStories, remaining: notDone.length };
  if (notDone.length > 0) criticalPath.at = notDone[0]!;

  const cycles = comps.filter((c) => c.length > 1);
  const cycleOf = new Map<number, number>();
  cycles.forEach((c, i) => c.forEach((v) => cycleOf.set(v, i)));

  const nodeList: ChainNode[] = order.map((n) => {
    const s = nodes.get(n)!;
    const node: ChainNode = {
      issue: n, title: s.title, state: s.state, done: s.state === "done",
      order: orderOf.get(n)!, level: level.get(compOf.get(n)!)!,
      dependsOn: deps.get(n)!, outside: outside.get(n)!,
    };
    if (cycleOf.has(n)) node.cycle = cycleOf.get(n)!;
    if (onPath.has(n)) node.critical = true;
    return node;
  });

  const edges: ChainEdge[] = [];
  for (const n of order) {
    for (const d of [...deps.get(n)!].sort((a, b) => orderOf.get(a)! - orderOf.get(b)!)) {
      const edge: ChainEdge = { from: n, to: d };
      const cf = compOf.get(n)!, ct = compOf.get(d)!;
      if (onPath.has(n) && onPath.has(d) && (cf === ct || posOf.get(cf)! - posOf.get(ct)! === 1)) edge.critical = true;
      edges.push(edge);
    }
  }

  const outsideNumbers = new Set<number>();
  for (const list of outside.values()) for (const d of list) outsideNumbers.add(d);
  const outsideList: OutsideStory[] = [...outsideNumbers].sort(asc).map((n) => {
    const o: OutsideStory = { issue: n };
    const title = byNumber.get(n)?.title;
    if (title !== undefined) o.title = title;
    return o;
  });

  return { order, nodes: nodeList, edges, outside: outsideList, cycles, criticalPath };
}
