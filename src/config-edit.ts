import { isDeepStrictEqual } from "node:util";
import { isMap, isNode, isScalar, isSeq, parseDocument, YAMLMap, type Document, type Node, type Pair } from "yaml";

type Plain = Record<string, unknown>;

/** The most pairs of list items one edit compares; a longer list is refused, so a save cannot block the server. */
export const SEQ_WORK_LIMIT = 250_000;

/** Same as JSON would see it: `undefined` keys are dropped. A top-level `undefined` stays `undefined`. */
const clean = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => isDeepStrictEqual(clean(a), clean(b));
const isObj = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string that names a value, the same for equal values whatever the key order. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x)) ?? "undefined";
}

const own = (n: unknown): boolean => isNode(n) && !!((n as Node).comment || (n as Node).commentBefore);

/** Is there a comment on this node or anywhere below it? */
function commented(n: unknown): boolean {
  if (!isNode(n)) return false;
  if (own(n)) return true;
  if (isMap(n)) return n.items.some((p) => own(p.key) || commented(p.value));
  if (isSeq(n)) return n.items.some(commented);
  return false;
}

const pairCommented = (p: Pair) => own(p.key) || commented(p.value);

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => (isScalar(p.key) ? p.key.value === key : p.key === key)) as Pair | undefined;
}

function dropPair(map: YAMLMap, pair: Pair) {
  map.items.splice(map.items.indexOf(pair as never), 1);
}

/** The new list item for the old node at `i`: edited in place when it can be, else a fresh node that keeps the comments. */
function editItem(doc: Document, node: unknown, oldV: unknown, newV: unknown): unknown {
  if (isMap(node) && isObj(oldV) && isObj(newV)) {
    editMap(doc, node, oldV, newV, undefined);
    return node;
  }
  if (isScalar(node) && !isObj(newV) && !Array.isArray(newV) && newV !== undefined) {
    node.value = newV;
    return node;
  }
  const fresh = doc.createNode(clean(newV)) as Node;
  if (isNode(node)) {
    fresh.commentBefore = (node as Node).commentBefore;
    fresh.comment = (node as Node).comment;
  }
  return fresh;
}

/** Matching pairs [old index, new index] of a longest common subsequence; only the part between equal ends is compared. */
function align(a: string[], b: string[]): [number, number][] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < lo; i++) out.push([i, i]);
  const n = ea - lo;
  const m = eb - lo;
  if (n > 0 && m > 0) {
    if (n * m > SEQ_WORK_LIMIT) throw new Error("this list is too long to change in place; edit config.yaml by hand");
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) {
        out.push([lo + i, lo + j]);
        i++;
        j++;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; ea + k < a.length; k++) out.push([ea + k, eb + k]);
  return out;
}

function editSeq(doc: Document, seq: { items: unknown[] }, oldArr: unknown[], newArr: unknown[]) {
  const olds = oldArr.map(canon);
  const news = newArr.map(canon);
  const matches = align(olds, news);
  const result: unknown[] = new Array(newArr.length);
  const idOf = (v: unknown) => (isObj(v) && typeof v.id === "string" ? v.id : undefined);
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  for (const [i, j] of matches) {
    result[j] = seq.items[i];
    usedOld.add(i);
    usedNew.add(j);
  }
  // an equal item that moved keeps its node too
  const spare = new Map<string, number[]>();
  olds.forEach((k, i) => {
    if (!usedOld.has(i)) spare.set(k, [...(spare.get(k) ?? []), i]);
  });
  news.forEach((k, j) => {
    if (usedNew.has(j)) return;
    const i = spare.get(k)?.shift();
    if (i === undefined) return;
    result[j] = seq.items[i];
    usedOld.add(i);
    usedNew.add(j);
  });
  const freeOld = oldArr.map((_, i) => i).filter((i) => !usedOld.has(i));
  const freeNew = newArr.map((_, j) => j).filter((j) => !usedNew.has(j));
  const pairs: [number, number][] = [];
  for (const j of [...freeNew]) {
    const id = idOf(newArr[j]);
    if (id === undefined) continue;
    const k = freeOld.findIndex((i) => idOf(oldArr[i]) === id);
    if (k < 0) continue;
    pairs.push([freeOld.splice(k, 1)[0]!, j]);
    freeNew.splice(freeNew.indexOf(j), 1);
  }
  while (freeOld.length && freeNew.length) {
    // an item with an id is only ever paired with the same id
    const i = freeOld.findIndex((x) => idOf(oldArr[x]) === undefined);
    const jj = freeNew.findIndex((x) => idOf(newArr[x]) === undefined);
    if (i < 0 || jj < 0) break;
    pairs.push([freeOld.splice(i, 1)[0]!, freeNew.splice(jj, 1)[0]!]);
  }
  for (const [i, j] of pairs) result[j] = editItem(doc, seq.items[i], oldArr[i], newArr[j]);
  for (const j of freeNew) result[j] = doc.createNode(clean(newArr[j]));
  seq.items = result;
}

function editMap(doc: Document, map: YAMLMap, oldObj: Plain, newObj: Plain, defs: Plain | undefined) {
  const keys = [...new Set([...Object.keys(oldObj), ...Object.keys(newObj)])];
  for (const key of keys) {
    const ov = oldObj[key];
    const nv = newObj[key];
    if (same(ov, nv)) continue;
    const pair = findPair(map, key);
    const dv = defs?.[key];
    if (nv === undefined || (dv !== undefined && !(isObj(nv) && isObj(ov)) && same(nv, dv))) {
      if (!pair) continue;
      if (nv === undefined || !pairCommented(pair)) {
        dropPair(map, pair);
        continue;
      }
    }
    const node = pair?.value;
    if (isObj(nv) && isObj(ov)) {
      let child: YAMLMap;
      let fresh = false;
      if (isMap(node)) child = node;
      else {
        child = doc.createNode({}) as YAMLMap;
        fresh = true;
      }
      editMap(doc, child, ov, nv, isObj(dv) ? dv : undefined);
      if (fresh) {
        if (child.items.length) map.set(key, child);
      } else if (!child.items.length && isObj(dv) && pair && !pairCommented(pair)) dropPair(map, pair);
      continue;
    }
    if (Array.isArray(nv) && Array.isArray(ov) && isSeq(node) && node.items.length === ov.length) {
      editSeq(doc, node, ov, nv);
      continue;
    }
    if (isScalar(node) && !isObj(nv) && !Array.isArray(nv)) {
      node.value = nv;
      continue;
    }
    map.set(key, doc.createNode(clean(nv)));
  }
}

/** The text with only the differences between `before` and `next` applied. Throws when the text is not YAML. */
export function editYamlText(text: string, before: Plain, next: Plain, defaults: Plain): string {
  if (same(before, next)) return text;
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`config.yaml cannot be read: ${doc.errors[0]!.message}`);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  const top = doc.contents as unknown as YAMLMap;
  editMap(doc, top, before, next, defaults);
  if (!top.items.length) {
    doc.contents = null;
    if (!doc.comment && !doc.commentBefore) return "";
  }
  return doc.toString({ lineWidth: 0 });
}
