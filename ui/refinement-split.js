import { h, toast } from "./dom.js";

// Splitting a draft on the draft page: the architect's ways, a way of your own, and a plan you change before anything is sent.
// The plan lives in memory only (it survives a redraw and an in-app reload, not a reload of the browser page). Every text is set as text.

export const SPLIT_TITLE = "Ways to split this story";
export const ASK_SPLIT = "Split";
export const ASK_AGAIN = "Ask again";
export const OWN = "Describe my own way";
export const OWN_SEND = "Ask with my way";
export const OWN_EMPTY = "Write your way first, in a few words.";
export const OUT_OF_DATE = "out of date";
export const OUT_OF_DATE_WHY = "The draft changed after these ways were asked.";
export const USE = "Use this way";
export const EMPTY_PLAN = "Start from an empty plan";
export const NOWHERE = "Fits nowhere";
export const NO_LIST = "In no list";
export const ADD_PART = "Add part";
export const CONFIRM = "Confirm split";
export const DISCARD = "Discard plan";
export const NOT_SENT = "Nothing is sent until you press Confirm split.";
export const CUT_WORDS = { step: "By step", interface: "By interface", data: "By data", rule: "By rule", spike: "Learn first (spike)" };
export const PARTS_MAX = 6;
export const PARTS_MIN = 2;
export const DRAFT_LIMIT = 20;
export const OWN_MAX = 500;
export const TITLE_MAX = 120;
const MIN_CRITERIA = 2;
const SEP = "\u0001";
const REMOVED = "A criterion that was removed.";

/** Plans in the making, by "<session>\u0001<draft>". */
export const splitLocal = new Map();
const ownLocal = new Map(); // the own way: { open, text }

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const oneLine = (t, max = 60) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const nodes = (v) => [v].flat(Infinity).filter(Boolean);

/** True when a draft can be split: two criteria or more, and not split, not a part, not on GitHub. */
export const canSplit = (d) => (d?.criteria?.length ?? 0) >= MIN_CRITERIA && !d.splitInto && !d.part && !d.published;

/** The architect's run when it is a split run of this draft, else null. */
export const splitRun = (s, did) => {
  const a = s?.architect;
  return a?.kind === "split" && a.draft === did ? a : null;
};

/** What the head shows: { kind: "line" | "none" | "button", again?, label? }. */
export function splitState(s, d) {
  const a = splitRun(s, d.id);
  const st = a?.state;
  if (a && (st === "queued" || st === "running")) return { kind: "line", again: "" };
  // Once the draft can no longer be split, the reason stays but there is nothing to ask again.
  if (a && st === "paused") return { kind: "line", again: canSplit(d) ? ASK_AGAIN : "" };
  if (a && st === "failed") return { kind: "line", again: canSplit(d) ? "Try again" : "" };
  const other = s.architect?.state;
  if (other === "queued" || other === "running" || other === "paused") return { kind: "none" };
  if (!s.brief || !canSplit(d)) return { kind: "none" };
  return { kind: "button", label: d.split ? ASK_AGAIN : ASK_SPLIT };
}

const planOf = (s, d) => splitLocal.get([s.id, d.id].join(SEP));
const ownOf = (s, d) => {
  const k = [s.id, d.id].join(SEP);
  if (!ownLocal.has(k)) ownLocal.set(k, { open: false, text: "" });
  return ownLocal.get(k);
};

/** Changes when the box must be drawn again. Typing a title does not change it. */
export const splitKey = (s, d) => JSON.stringify([
  splitState(s, d), splitRun(s, d.id), d.split ?? null, d.splitInto ?? null, canSplit(d), (d.criteria ?? []).map((c) => [c.id, c.text]),
  planOf(s, d) ? planOf(s, d).rev : null, ownOf(s, d).open, (s.drafts ?? []).length,
]);

let counter = 0;
const newKey = () => `k${++counter}`;
const newPart = (title = "", sentence = "") => ({ key: newKey(), title, sentence, dependsOn: [] });

/** A plan from way `n` of the stored ways (asked at `at`): its stories as parts, its criteria in their lists. */
export function planFromWay(w, n, at) {
  const parts = w.stories.map((x) => newPart(x.title, x.sentence));
  const place = {};
  w.stories.forEach((x, i) => {
    x.criteria.forEach((id) => { place[id] = parts[i].key; });
    parts[i].dependsOn = x.dependsOn.map((m) => parts[m - 1]?.key).filter(Boolean);
  });
  w.unplaced.forEach((id) => { place[id] = "nowhere"; });
  return { way: n, at, rev: 0, parts, place };
}

/** A plan of two untitled parts; every criterion is in no list. */
export const emptyPlan = () => ({ way: undefined, at: undefined, rev: 0, parts: [newPart(), newPart()], place: {} });

const listOf = (plan, id) => {
  const p = plan.place[id];
  return p === "nowhere" || plan.parts.some((x) => x.key === p) ? p : undefined;
};

/** The first thing wrong with the plan, in words, or "". `count`: the drafts in the session now. */
export function planProblem(plan, d, count) {
  if (plan.parts.length < PARTS_MIN) return `A split needs at least ${PARTS_MIN} parts.`;
  const blank = plan.parts.findIndex((p) => !p.title.trim());
  if (blank >= 0) return `Part ${blank + 1} needs a title.`;
  const loose = d.criteria.find((c) => listOf(plan, c.id) === undefined);
  if (loose) return `This criterion is in no list: "${oneLine(loose.text)}". Move it to a part or to "${NOWHERE}".`;
  for (let i = 0; i < plan.parts.length; i++) {
    for (const k of plan.parts[i].dependsOn) {
      const j = plan.parts.findIndex((x) => x.key === k);
      if (j > i) return `Part ${i + 1} depends on part ${j + 1}, which comes later. Change the order or remove the dependency.`;
    }
  }
  if (count + plan.parts.length > DRAFT_LIMIT) return `A session has at most ${DRAFT_LIMIT} story drafts. This split would make ${count + plan.parts.length}.`;
  return "";
}

/** The body of the confirm call. */
export function planBody(plan, d) {
  const inList = (v) => d.criteria.filter((c) => plan.place[c.id] === v).map((c) => c.id);
  return {
    ...(plan.way !== undefined && plan.at === d.split?.at ? { way: plan.way } : {}),
    parts: plan.parts.map((p) => ({
      title: p.title.trim(),
      ...(p.sentence ? { sentence: p.sentence } : {}),
      criteria: inList(p.key),
      dependsOn: p.dependsOn.map((k) => plan.parts.findIndex((x) => x.key === k) + 1).filter((n) => n > 0).sort((a, b) => a - b),
    })),
    unplaced: inList("nowhere"),
  };
}

/** A log line of a split in words, or "" when the line is not one of them. */
export function splitLogText(entry) {
  const who = entry.who || "Someone";
  const n = /^\d+$/.test(String(entry.detail ?? "")) ? Number(entry.detail) : null;
  if (entry.what === "split-asked") return `${who} asked the architect for ways to split a story draft`;
  if (entry.what === "architect-split") return n === null ? "The architect proposed ways to split a story draft" : `The architect proposed ${plural(n, "way", "ways")} to split a story draft`;
  if (entry.what === "draft-split") return n === null ? `${who} split a story draft` : `${who} split a story draft into ${n} drafts`;
  if (entry.what === "criterion-moved") return `${who} moved a criterion to another draft${entry.detail ? `: "${entry.detail}"` : ""}`;
  if (entry.what === "drafts-merged") {
    const detail = String(entry.detail ?? "");
    if (!detail) return `${who} merged two story drafts`;
    const i = detail.indexOf("; removed ");
    const raw = i >= 0 ? detail.slice(0, i) : detail;
    // The titles are not escaped in the detail: when it cannot be read in one way only, the plain sentence is used.
    if (detail.split("; removed ").length > 2 || !/^"[^]*" \+ "[^]*"$/.test(raw) || raw.split('" + "').length !== 2) return `${who} merged two story drafts`;
    const head = raw.replace('" + "', '" and "');
    return `${who} merged two story drafts: ${head}${i >= 0 ? `. Dependencies that no longer fit the split were removed: ${detail.slice(i + 10)}` : ""}`;
  }
  return "";
}

// ---- the ways ----
const warningText = (v) => (v.kind === "layer"
  ? `Story ${v.story} delivers nothing a user can see or check: ${v.why}`
  : `Stories ${v.stories[0]} and ${v.stories[1]} touch the same code: ${v.why}`);

function wayNodes(s, d, w, n, act) {
  const text = (id) => d.criteria.find((c) => c.id === id)?.text ?? REMOVED;
  const out = [h("h4", {}, `Way ${n + 1}: ${CUT_WORDS[w.cut] ?? w.cut}`)];
  out.push(h("ol", {}, w.stories.map((x) => h("li", {}, h("b", {}, x.title), h("span", { class: "said" }, x.sentence),
    x.dependsOn.length ? h("small", { class: "muted" }, `Depends on: story ${x.dependsOn.join(", ")}`) : null,
    h("ul", {}, x.criteria.map((id) => h("li", {}, text(id))))))));
  out.push(h("p", {}, h("b", {}, "The first story already delivers: "), w.first));
  out.push(h("h4", {}, NOWHERE), w.unplaced.length ? h("ul", {}, w.unplaced.map((id) => h("li", {}, text(id)))) : h("p", { class: "muted" }, "Every criterion has a place."));
  if (w.warnings.length) out.push(h("ul", {}, w.warnings.map((v) => h("li", {}, h("span", { class: "pill" }, "Warning"), warningText(v)))));
  if (act && canSplit(d)) {
    out.push(h("button", { class: "small", "data-focus": `split-use-${n + 1}`, onClick: () => {
      splitLocal.set([s.id, d.id].join(SEP), planFromWay(w, n, d.split.at));
      act.redraw();
    } }, USE));
  }
  return out;
}

// ---- the plan ----
function planNodes(s, d, plan, act) {
  const key = [s.id, d.id].join(SEP);
  const count = (s.drafts ?? []).length;
  const bump = () => {
    plan.rev += 1;
    act.redraw();
  };
  const problem = h("p", { class: "status bad", "data-split-problem": "" });
  const confirmBtn = h("button", { class: "primary", "data-focus": "split-confirm", onClick: async (e) => {
    if (planProblem(plan, d, count)) return;
    const made = plan.parts.length;
    const ok = await act.split(e.currentTarget, (dNow) => {
      const p = planProblem(plan, dNow, count);
      if (p) throw new Error(p);
      return planBody(plan, dNow);
    });
    if (ok) {
      splitLocal.delete(key);
      toast(`The draft is split into ${made} drafts.`);
    }
  } }, CONFIRM);
  const creates = h("span", { class: "muted" });
  const refresh = () => {
    const p = planProblem(plan, d, count);
    problem.textContent = p;
    confirmBtn.disabled = Boolean(p);
    creates.textContent = `This creates ${plural(plan.parts.length, "new draft", "new drafts")}.`;
  };

  const mover = (c) => {
    const here = listOf(plan, c.id);
    const sel = h("select", { "aria-label": `Move: ${oneLine(c.text)}`, "data-focus": `split-move-${c.id}`, onChange: () => {
      const v = sel.value;
      if (!v) return;
      plan.place[c.id] = v === "nowhere" ? "nowhere" : v.slice(2);
      bump();
    } }, [
      here === undefined ? h("option", { value: "" }, "Choose…") : null,
      ...plan.parts.map((p, i) => h("option", { value: `p:${p.key}` }, `Part ${i + 1}`)),
      h("option", { value: "nowhere" }, NOWHERE),
    ]);
    sel.value = here === undefined ? "" : here === "nowhere" ? "nowhere" : `p:${here}`;
    return sel;
  };
  const items = (list) => (list.length ? h("ul", {}, list.map((c) => h("li", {}, c.text, mover(c)))) : null);
  const criteriaIn = (v) => d.criteria.filter((c) => listOf(plan, c.id) === v);

  const parts = plan.parts.map((p, i) => {
    const others = plan.parts.filter((x) => x !== p);
    const move = (by) => {
      const j = i + by;
      [plan.parts[i], plan.parts[j]] = [plan.parts[j], plan.parts[i]];
      bump();
    };
    const title = h("input", { value: p.title, maxlength: TITLE_MAX, "aria-label": `Title of part ${i + 1}`, "data-focus": `split-title-${p.key}`, onInput: () => {
      p.title = title.value;
      refresh();
    } });
    return h("li", {},
      h("b", {}, `Part ${i + 1}`),
      title,
      i > 0 ? h("button", { class: "small", "data-focus": `split-up-${p.key}`, onClick: () => move(-1) }, "Up") : null,
      i < plan.parts.length - 1 ? h("button", { class: "small", "data-focus": `split-down-${p.key}`, onClick: () => move(1) }, "Down") : null,
      h("button", { class: "small danger", "data-focus": `split-remove-${p.key}`, onClick: () => {
        plan.parts = plan.parts.filter((x) => x !== p);
        for (const x of plan.parts) x.dependsOn = x.dependsOn.filter((k) => k !== p.key);
        bump();
      } }, "Remove part"),
      p.sentence ? h("p", { class: "muted said" }, p.sentence) : null,
      others.length ? h("div", {}, "Depends on:", others.map((o) => {
        const cb = h("input", { type: "checkbox", "data-focus": `split-dep-${p.key}-${o.key}`, onChange: () => {
          p.dependsOn = cb.checked ? [...p.dependsOn, o.key] : p.dependsOn.filter((k) => k !== o.key);
          refresh();
        } });
        cb.checked = p.dependsOn.includes(o.key);
        return h("label", { class: "check" }, cb, `Part ${plan.parts.indexOf(o) + 1}`);
      })) : null,
      items(criteriaIn(p.key)));
  });
  const nowhere = items(criteriaIn("nowhere"));
  const loose = items(criteriaIn(undefined));
  const add = h("button", { class: "small", "data-focus": "split-add", onClick: () => {
    plan.parts.push(newPart());
    bump();
  } }, ADD_PART);
  add.disabled = plan.parts.length >= PARTS_MAX;
  refresh();
  return [
    h("p", { class: "muted" }, NOT_SENT),
    h("ol", { class: "plan-parts" }, parts),
    h("h4", {}, NOWHERE), nowhere,
    loose ? [h("h4", {}, NO_LIST), loose] : null,
    add, problem,
    h("div", { class: "row" }, confirmBtn, creates, h("button", { "data-focus": "split-discard", onClick: () => {
      splitLocal.delete(key);
      bump();
    } }, DISCARD)),
  ];
}

// ---- the whole box ----
function ownNodes(s, d, act) {
  const own = ownOf(s, d);
  const out = [h("button", { class: "small", "data-focus": "split-own", onClick: () => {
    own.open = !own.open;
    act.redraw();
  } }, OWN)];
  if (!own.open) return out;
  const bad = h("p", { class: "status bad" });
  const ta = h("textarea", { name: "own-way", rows: 3, maxlength: OWN_MAX, "aria-label": OWN, "data-focus": "split-own-text", onInput: () => {
    own.text = ta.value;
  } });
  ta.value = own.text;
  out.push(ta, bad, h("button", { class: "small", onClick: async (e) => {
    const text = own.text.trim();
    if (!text) {
      bad.textContent = OWN_EMPTY;
      return;
    }
    bad.textContent = "";
    if (await act.ask(e.currentTarget, text)) {
      own.text = "";
      own.open = false;
    }
  } }, OWN_SEND));
  return out;
}

/**
 * The nodes of the split part. `act` null: read-only (the ways, no buttons; [] without ways).
 * Otherwise `act`: { line(architect), redraw(), ask(btn, own?), split(btn, bodyOf(draft)) }.
 */
export function splitNodes(s, d, act) {
  if (!act) return d.split ? [h("h4", {}, SPLIT_TITLE), metaLine(d.split), ...d.split.ways.map((w, n) => wayNodes(s, d, w, n, null))] : [];
  const st = splitState(s, d);
  const plan = planOf(s, d);
  if (st.kind !== "line" && !canSplit(d) && !d.split && !plan) return [];
  const out = [h("h4", {}, SPLIT_TITLE)];
  const ask = (text) => h("button", { class: "small", "data-focus": "split-ask", onClick: (e) => act.ask(e.currentTarget) }, text);
  if (st.kind === "line") {
    out.push(act.line(s.architect));
    if (st.again) out.push(ask(st.again));
  } else if (st.kind === "button") out.push(ask(st.label));
  const run = splitRun(s, d.id);
  if (st.kind === "button" || (run && run.state === "failed")) out.push(...ownNodes(s, d, act));
  if (plan) {
    out.push(...planNodes(s, d, plan, act));
    return nodes(out);
  }
  if (d.split) out.push(metaLine(d.split), ...d.split.ways.map((w, n) => wayNodes(s, d, w, n, act)));
  if (canSplit(d)) out.push(h("button", { class: "small", "data-focus": "split-empty", onClick: () => {
    splitLocal.set([s.id, d.id].join(SEP), emptyPlan());
    act.redraw();
  } }, EMPTY_PLAN));
  return nodes(out);
}

const metaLine = (split) => h("p", { class: "muted" }, `Asked ${new Date(split.at).toLocaleString()}`,
  split.outOfDate ? [" ", h("span", { class: "pill" }, OUT_OF_DATE), " ", OUT_OF_DATE_WHY] : null);
