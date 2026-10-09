import { api } from "./api.js";
import { aiProps, h, mount, toast } from "./dom.js";
import { impactKey, impactNodes } from "./refinement-impact.js";
import { draftStateText, readyKey, readyNodes } from "./refinement-ready.js";
import { REMARK_FIELDS, MOVE_ASK, remarkKey, remarkNodes, orphanRemarks, reviewKey, reviewNodes } from "./refinement-remarks.js";
import { mayDependOn, mergeNodes, moveNodes, partsKey, partsNodes } from "./refinement-parts.js";
import { splitKey, splitNodes } from "./refinement-split.js";
import { FIELD_LABELS as LABELS, SUGGEST_FIELDS, TEXT_FIELDS, NO_BRIEF, boxKey, fromText, shownFrom, suggestNodes } from "./refinement-suggest.js";

// The story drafts of a refinement session: write, save as you type, preview. Every text is set as text, never as HTML.

export const DRAFTS_HIDDEN = "The story drafts are not shown while the repository is not in My repositories.";
export const SAVE_MS = 1000;
const SEP = "\u0001";
const NONE = "None (can be built on its own).";

/** Texts typed but not saved yet: "<session>\u0001<draft>\u0001<field>" → text. They survive a redraw and a failed save. */
export const unsaved = new Map();
/** The draft that is open, by session. */
export const opened = new Map();
const timers = new Map();
let cur = null; // the controller of the page that is shown: a timer that fires after a reload finds it here
let guarded = false;

/** True when the fields and buttons of the drafts may be shown: an own session that is open and whose repository is there. */
export const mayChange = (s) => Boolean(s?.mine) && s.state !== "dropped" && s.repoAvailable !== false && !s.draftsHidden;

/** The title of a draft in a list. */
export const draftTitle = (d) => String(d?.preview?.title || d?.title?.text || "Untitled draft");

/** An issue number typed by a person ("12", "#12"): a whole number from 1 the server takes; null otherwise. */
export function issueNumber(v) {
  const t = String(v ?? "").trim().replace(/^#/, "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** For `beforeunload`: asks the browser to stop the page from closing while text is not saved. */
export function beforeLeave(e) {
  if (!unsaved.size) return undefined;
  e.preventDefault();
  e.returnValue = "";
  return "";
}

/**
 * The preview of a draft as parts. The head, the criteria and Depends on are read from the server's `preview.body` at places
 * typed text cannot move; the two long texts come from the draft itself, because they may hold lines that look like headings.
 */
export function previewParts(d) {
  const out = { epic: null, sentence: "", criteria: null, outOfScope: d?.outOfScope?.text ?? "", notes: d?.notes?.text ?? "", depends: null, accepted: null };
  let rest = d?.preview?.body;
  if (typeof rest !== "string") return out;
  const m = /^\*\*Epic:\*\* #(\d+)\n\n/.exec(rest);
  if (m) {
    out.epic = Number(m[1]);
    rest = rest.slice(m[0].length);
  }
  const i = rest.indexOf("\n\n");
  out.sentence = i < 0 ? rest : rest.slice(0, i);
  const DEP = "\n\n### Depends on\n";
  const j = rest.lastIndexOf(DEP);
  if (j >= 0) {
    const tail = rest.slice(j + DEP.length);
    const ACC = "\n\n### Accepted anyway\n";
    const k = tail.indexOf(ACC);
    const deps = k < 0 ? tail : tail.slice(0, k);
    out.depends = deps.startsWith("None (") ? [] : deps.split("\n").map((l) => l.replace(/^- /, ""));
    if (k >= 0) out.accepted = tail.slice(k + ACC.length).split("\n").map((l) => l.replace(/^- /, ""));
  }
  if (i >= 0) {
    const lines = rest.slice(i + 2).split("\n").slice(1);
    const crit = [];
    for (const l of lines) {
      if (!l.startsWith("- [ ] ")) break;
      crit.push(l.slice(6));
    }
    out.criteria = crit;
  }
  return out;
}

const checkbox = () => {
  const cb = h("input", { type: "checkbox", "aria-hidden": "true" });
  cb.disabled = true;
  cb.setAttribute("disabled", "");
  return cb;
};

/** The story as it will look: the fixed structure is drawn, the person's text is shown as typed. */
export function previewNodes(d) {
  const p = previewParts(d);
  return h("div", { class: "card" },
    h("p", {}, h("b", {}, draftTitle(d))),
    p.epic !== null ? h("p", {}, `Epic: #${p.epic}`) : null,
    h("p", { class: "said" }, p.sentence),
    h("h4", {}, "Acceptance criteria"),
    p.criteria?.length ? h("ul", { class: "checks" }, p.criteria.map((t) => h("li", {}, checkbox(), t))) : h("p", { class: "muted" }, "None yet."),
    p.outOfScope ? [h("h4", {}, "Out of scope"), h("p", { class: "said" }, p.outOfScope)] : null,
    p.notes ? [h("h4", {}, "Notes for the builder"), h("p", { class: "said" }, p.notes)] : null,
    h("h4", {}, "Depends on"),
    p.depends?.length ? h("ul", {}, p.depends.map((t) => h("li", {}, t))) : h("p", { class: "muted" }, NONE),
    p.accepted?.length ? [h("h4", {}, "Accepted anyway"), h("ul", {}, p.accepted.map((t) => h("li", {}, t)))] : null);
}

/** For a view that cannot change the drafts: the waiting suggestions and where the texts came from, without any button. */
function readOnlyNodes(s, d) {
  const sug = SUGGEST_FIELDS.map((f) => {
    const n = nodes(suggestNodes(s, d, f, null));
    return n.length ? [h("h4", {}, LABELS[f]), n] : null;
  }).filter(Boolean);
  const from = [
    ...TEXT_FIELDS.filter((f) => fromText(d[f]?.from)).map((f) => `${LABELS[f]}: ${fromText(d[f].from)}`),
    ...d.criteria.filter((c) => fromText(c.from)).map((c) => `${LABELS.criteria}: ${c.text} (${fromText(c.from)})`),
    ...d.dependsOn.filter((x) => fromText(x.from)).map((x) => `${LABELS.dependsOn}: ${x.issue !== undefined ? `#${x.issue}` : `${draftTitle((s.drafts ?? []).find((o) => o.id === x.draft))} (draft)`} (${fromText(x.from)})`),
  ];
  if (!sug.length && !from.length) return null;
  return h("div", { class: "card" },
    sug.length ? [h("b", {}, "Suggested"), sug] : null,
    from.length ? [h("b", {}, "Where the text came from"), h("ul", {}, from.map((t) => h("li", {}, t)))] : null);
}

/** The link to the issue of a published draft; plain text when the address is not on github.com. */
function issueLink(d) {
  const text = `#${d.published.issue}`;
  const url = String(d.published.url ?? "");
  return url.startsWith("https://github.com/") ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text) : text;
}

const dependsItem = (x) => (x.issue !== undefined ? { id: x.id, issue: x.issue } : { id: x.id, draft: x.draft });
/** Marks `el` as AI-written while the visible value came from a suggestion (`from` "accepted" or "accepted, then edited"); clears it otherwise. */
function markAi(el, from, what) {
  if (!el) return;
  if (String(from).startsWith("accepted")) {
    const p = aiProps(what);
    el.setAttribute("role", p.role);
    el.setAttribute("aria-label", p["aria-label"]);
  } else {
    el.removeAttribute("role");
    el.removeAttribute("aria-label");
  }
}

const nodes = (v) => [v].flat(Infinity).filter(Boolean);

/**
 * The "Story drafts" part. Returns { node, update(s), leave() }.
 * `ctx`: id of the session; `send(btn, call)` runs a button's change (shows the answer, reloads after a failure);
 * `save(call)` runs a change in turn and shows its answer (a failure is thrown); `errorText(e)`;
 * `statusLine(a)`: the status line node of the architect, or null.
 */
export function draftSection(ctx) {
  const sid = ctx.id;
  const K = (did, f) => [sid, did, f].join(SEP);
  let sess = null;
  let status = { text: "", bad: false };
  let markdown = false;
  let focusTitle = false;
  let ed = null; // the open editor
  const root = h("section", { class: "drafts" });
  const boxes = { top: h("div"), epic: h("div"), list: h("div"), editor: h("div"), lost: h("div") };
  root.append(h("h2", {}, "Story drafts"), ...Object.values(boxes));
  const memo = {};
  const fill = (name, key, build) => {
    if (memo[name] === key) return;
    memo[name] = key;
    boxes[name].replaceChildren(...nodes(build()));
  };
  const epicInput = h("input", { name: "epic", placeholder: "Issue number", autocomplete: "off", "aria-label": "Epic" });
  const can = () => Boolean(sess) && mayChange(sess);
  const draftOf = (did) => (sess?.drafts ?? []).find((x) => x.id === did);

  const placeOf = (key) => {
    const [s, did, f] = key.split(SEP);
    if (s !== sid || !ed || ed.did !== did || !f) return null;
    return f.startsWith("crit:") ? ed.rows.get(key) ?? null : ed.fields.get(f) ?? null;
  };
  const keysOf = (did) => [...unsaved.keys()].filter((k) => k.startsWith(`${sid}${SEP}${did}${SEP}`));
  const forget = (key) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    unsaved.delete(key);
  };
  const plan = (key) => {
    failed.delete(key);
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      cur?.flush(key);
    }, SAVE_MS));
  };
  const failed = new Set(); // keys whose last save failed: no request is planned for them until they change again
  let lastError = "";
  let lastStatus; // the HTTP status of the last failed save
  const pending = () => [...unsaved.keys()].some((k) => placeOf(k) && !failed.has(k));
  const setStatus = (text, bad = false) => {
    status = { text, bad };
    if (!ed) return;
    ed.statusEl.textContent = text;
    ed.statusEl.setAttribute("class", bad ? "status bad" : "status");
  };

  const adopt = (row, id, sent) => {
    const old = row.key;
    const newer = unsaved.get(old);
    const timer = timers.has(old);
    forget(old);
    // The pending text gets the new id also when the editor was closed meanwhile; only the page work needs the editor.
    const live = ed?.did === row.did;
    if (live) ed.rows.delete(old);
    row.id = id;
    row.key = K(row.did, `crit:${id}`);
    if (newer !== undefined && newer !== sent) {
      unsaved.set(row.key, newer);
      if (timer) plan(row.key);
    }
    if (!live) return;
    row.ta.setAttribute("data-focus", `crit-${id}`);
    row.li.insertBefore(removeButton(row), row.rem);
    row.rem.setAttribute("data-remarks", `crit-${id}`);
    ed.rows.set(row.key, row);
    ed.byId.set(id, row);
    ed.newRow = makeRow(null);
    ed.rows.set(ed.newRow.key, ed.newRow);
  };

  /** Sends one typed field; the text stays in `unsaved` until the server has it. */
  const flush = (key) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (!unsaved.has(key) || !can()) return Promise.resolve(true);
    const p = placeOf(key);
    if (!p) return Promise.resolve(true);
    const did = key.split(SEP)[1];
    const f = key.split(SEP)[2];
    const keyNow = () => (p.li ? p.key : key);
    const run = async () => {
      const text = unsaved.get(keyNow());
      if (text === undefined) return undefined;
      if (!p.li) {
        const next = await api.saveDraft(sid, did, { [f]: text });
        if (unsaved.get(key) === text) unsaved.delete(key);
        return next;
      }
      const d = draftOf(did);
      if (!d) return undefined;
      const known = new Set(d.criteria.map((c) => c.id));
      const body = d.criteria.map((c) => ({ id: c.id, text: p.id === c.id ? text : c.text }));
      if (!p.id) body.push({ text });
      const next = await api.saveDraft(sid, did, { criteria: body });
      if (!p.id) {
        const added = next.drafts?.find((x) => x.id === did)?.criteria.find((c) => !known.has(c.id));
        if (added) adopt(p, added.id, text);
      }
      if (unsaved.get(p.key) === text) unsaved.delete(p.key);
      return next;
    };
    return ctx.save(run).then(
      (next) => {
        if (next === undefined) return true;
        failed.delete(keyNow());
        if (pending()) setStatus("Saving…");
        else if ([...failed].some((k) => unsaved.has(k) && placeOf(k))) setStatus(lastError, true); // another field is still not saved: keep saying so
        else setStatus("Saved");
        return true;
      },
      (e) => {
        lastError = ctx.errorText(e);
        lastStatus = e?.status;
        failed.add(keyNow());
        setStatus(lastError, true);
        return false;
      });
  };
  /** Sends every typed text of the session; the promises say whether each was saved. */
  const flushAll = () => [...unsaved.keys()].filter((k) => k.startsWith(`${sid}${SEP}`)).map((k) => flush(k));

  // ---- the criteria: one row each, a row in use is never taken out of the page ----
  const removeButton = (row) => h("button", { class: "danger", "data-focus": `crit-remove-${row.id}`, onClick: (e) => {
    const did = row.did;
    const key = row.key;
    clearTimeout(timers.get(key));
    timers.delete(key);
    // The list is built when the request's turn comes, after any save in flight; the typed text stays until the row is gone.
    return ctx.send(e.currentTarget, () => {
      const d = draftOf(did);
      return api.saveDraft(sid, did, { criteria: (d?.criteria ?? []).filter((c) => c.id !== row.id).map((c) => ({ id: c.id, text: c.text })) })
        .then((next) => {
          forget(row.key);
          return next;
        });
    }).then((ok) => {
      if (!ok && unsaved.has(row.key)) plan(row.key);
      return ok;
    });
  } }, "Remove");

  function makeRow(c) {
    const row = { did: ed.did, id: c?.id, key: K(ed.did, c ? `crit:${c.id}` : "crit:new") };
    row.ta = h("textarea", { rows: 2, "aria-label": "Acceptance criterion", "data-focus": c ? `crit-${c.id}` : "crit-new",
      onInput: () => {
        const text = row.ta.value;
        if (!text.trim()) {
          forget(row.key); // an emptied one is not sent; it gets its text back when left
          return markRow(row);
        }
        unsaved.set(row.key, text);
        markRow(row);
        setStatus("Saving…");
        plan(row.key);
      },
      onBlur: () => {
        if (unsaved.has(row.key)) return flush(row.key);
        return syncRow(row, draftOf(ed?.did));
      } });
    row.mark = h("small", { class: "muted" });
    row.rem = h("div", { class: "remarks", "data-remarks": c ? `crit-${c.id}` : "crit-new" });
    row.remKey = "";
    row.mv = h("span", { "data-move": "" });
    row.mvKey = "";
    row.li = h("li", { class: "entry" }, row.ta, row.mark, c ? removeButton(row) : null, row.mv, row.rem);
    return row;
  }
  const savedText = (row, d) => d?.criteria.find((c) => c.id === row.id)?.text ?? "";
  // Where the text on the page came from: it follows what is visible, also while it is not saved.
  const markRow = (row, d = draftOf(row.did)) => {
    const from = shownFrom(d?.criteria.find((c) => c.id === row.id), row.ta.value);
    row.mark.textContent = fromText(from);
    markAi(row.li, from, "accepted acceptance criterion");
  };
  const syncRow = (row, d) => {
    if (!unsaved.has(row.key) && row.ta !== document.activeElement) {
      const v = savedText(row, d);
      if (row.ta.value !== v) row.ta.value = v;
    }
    markRow(row, d);
  };

  /** Puts the rows in the server's order, moving only rows that are not the focused one. */
  const placeRows = (want) => {
    const list = ed.critList;
    const kids = () => Array.from(list.children);
    if (kids().length === want.length && want.every((r, i) => kids()[i] === r.li)) return;
    const active = want.find((r) => r.ta === document.activeElement);
    const k = active ? want.indexOf(active) : -1;
    const before = want.slice(0, Math.max(k, 0));
    const after = want.slice(k + 1);
    if (active) {
      let ref = active.li;
      for (const r of [...before].reverse()) {
        if (kids()[kids().indexOf(ref) - 1] !== r.li) list.insertBefore(r.li, ref);
        ref = r.li;
      }
    }
    let prev = active ? active.li : null;
    for (const r of after) {
      const next = prev ? kids()[kids().indexOf(prev) + 1] ?? null : kids()[0] ?? null;
      if (next !== r.li) list.insertBefore(r.li, next);
      prev = r.li;
    }
  };
  const syncCriteria = (d) => {
    const want = [];
    for (const c of d.criteria) {
      let row = ed.byId.get(c.id);
      if (!row) {
        row = makeRow(c);
        ed.byId.set(c.id, row);
        ed.rows.set(row.key, row);
      }
      syncRow(row, d);
      want.push(row);
    }
    syncRow(ed.newRow, d);
    want.push(ed.newRow);
    for (const row of [...ed.rows.values()]) {
      if (want.includes(row)) continue;
      row.li.remove();
      ed.rows.delete(row.key);
      if (row.id) ed.byId.delete(row.id);
    }
    placeRows(want);
  };

  // ---- the editor ----
  const field = (d, f, tag, rows) => {
    const key = K(d.id, f);
    const el = h(tag, { name: f, "aria-label": LABELS[f], "data-focus": `field-${f}`, ...(tag === "textarea" ? { rows } : { autocomplete: "off" }),
      onInput: () => {
        unsaved.set(key, el.value);
        markField(f);
        setStatus("Saving…");
        plan(key);
      },
      onBlur: () => {
        if (unsaved.has(key)) return flush(key);
        const v = draftOf(d.id)?.[f]?.text ?? "";
        if (el.value !== v && el !== document.activeElement) el.value = v;
        markField(f); // the saved text may differ from what was typed (trimmed)
        return undefined;
      } });
    el.value = unsaved.get(key) ?? d[f]?.text ?? "";
    ed.fields.set(f, el);
    const mark = h("small", { class: "muted", "data-mark": f });
    ed.marks.set(f, mark);
    markField(f);
    const box = h("div", { class: "suggest", "data-suggest": f });
    ed.sug.set(f, box);
    if (!REMARK_FIELDS.includes(f)) return [h("label", { class: "field" }, h("span", {}, LABELS[f]), el, mark), box]; // buttons must not sit inside the label
    const rem = h("div", { class: "remarks", "data-remarks": f });
    ed.rem.set(f, rem);
    return [h("label", { class: "field" }, h("span", {}, LABELS[f]), el, mark), rem, box];
  };
  const markField = (f) => {
    const el = ed.fields.get(f);
    const mark = ed.marks.get(f);
    if (!el || !mark) return;
    const from = shownFrom(draftOf(ed.did)?.[f], el.value);
    mark.textContent = fromText(from);
    markAi(mark.parent, from, `accepted text for ${LABELS[f]}`);
  };

  const dependsText = (x) => (x.issue !== undefined ? `#${x.issue}` : `${draftTitle(draftOf(x.draft))} (draft)`);
  const changeDepends = (btn, did, make) => {
    const d = draftOf(did);
    if (!d) return undefined;
    return ctx.send(btn, () => api.saveDraft(sid, did, { dependsOn: make(d.dependsOn.map(dependsItem)) }));
  };
  const renderDepends = (d) => {
    const others = (sess.drafts ?? []).filter((o) => o.id !== d.id && !d.dependsOn.some((x) => x.draft === o.id) && mayDependOn(d, o, sess.drafts ?? []));
    const key = JSON.stringify([d.dependsOn, (sess.drafts ?? []).map((o) => [o.id, draftTitle(o)]), others.map((o) => o.id)]);
    if (ed.dependsKey === key) return;
    ed.dependsKey = key;
    const select = others.length ? h("select", { "aria-label": "Another draft" }, others.map((o) => h("option", { value: o.id }, draftTitle(o)))) : null;
    if (select) select.value = others[0].id;
    ed.depList.replaceChildren(...nodes(d.dependsOn.length ? h("ul", {}, d.dependsOn.map((x) => h("li", { class: "entry" }, h("span", String(x.from).startsWith("accepted") ? aiProps("accepted suggestion for Depends on") : {}, dependsText(x)), h("small", { class: "muted" }, fromText(x.from)),
      h("button", { class: "danger", onClick: (e) => changeDepends(e.currentTarget, d.id, (list) => list.filter((y) => y.id !== x.id)) }, "Remove")))) : h("p", { class: "muted" }, NONE)));
    ed.depChoose.replaceChildren(...nodes(select ? [select, h("button", { onClick: (e) => {
      if (!select.value) return undefined;
      return changeDepends(e.currentTarget, d.id, (list) => [...list, { draft: select.value }]);
    } }, "Add draft")] : null));
  };

  const renderPreview = (d) => {
    ed.previewBox.replaceChildren(...nodes([
      h("div", { class: "row" }, h("b", {}, "Preview"), h("span", { class: "spacer" }),
        h("button", { onClick: () => {
          markdown = !markdown;
          renderPreview(draftOf(ed.did) ?? d);
        } }, markdown ? "Show the preview" : "Show as Markdown")),
      markdown ? h("pre", {}, d.preview?.body ?? "") : previewNodes(d),
    ]));
  };

  /** The button that removes a draft (also a split original) after a confirmation. */
  const removeDraftButton = (did) => h("button", { class: "danger", onClick: (e) => {
    if (!confirm("Remove this story draft?")) return undefined;
    // The typed text stays until the draft is really gone; a refused or failed request gives it its timer back.
    const keys = keysOf(did);
    keys.forEach((k) => {
      clearTimeout(timers.get(k));
      timers.delete(k);
    });
    return ctx.send(e.currentTarget, () => api.removeDraft(sid, did).then((next) => {
      opened.delete(sid);
      keysOf(did).forEach(forget);
      return next;
    })).then((ok) => {
      if (!ok) for (const k of keys) if (unsaved.has(k)) plan(k);
      return ok;
    });
  } }, "Remove draft");

  const buildEditor = (d) => {
    ed = { did: d.id, fields: new Map(), rows: new Map(), byId: new Map(), dependsKey: "", sug: new Map(), sugKeys: new Map(), marks: new Map(), rem: new Map(), remKeys: new Map() };
    ed.hint = h("p", { class: "muted" });
    ed.partsBox = h("div", { class: "parts", "data-parts": "" });
    ed.mergeBox = h("div", { class: "row", "data-merge": "" });
    ed.reviewBox = h("div", { class: "review", "data-review": "" });
    ed.impactBox = h("div", { class: "impact", "data-impact": "" });
    ed.splitBox = h("div", { class: "split", "data-split": "" });
    ed.readyBox = h("div", { class: "ready", "data-ready": "" }); // a div: the card has no direct h4 child (the preview card is found by it)
    ed.reviewKey = "";
    ed.orphans = h("div", { class: "remarks", "data-remarks": "criteria" });
    ed.orphanKey = "";
    for (const f of ["criteria", "dependsOn"]) ed.sug.set(f, h("div", { class: "suggest", "data-suggest": f }));
    ed.statusEl = h("p", { class: status.bad ? "status bad" : "status" }, status.text);
    ed.critList = h("ul", {});
    ed.newRow = makeRow(null);
    ed.rows.set(ed.newRow.key, ed.newRow);
    ed.depList = h("div");
    ed.depChoose = h("div", { class: "row" });
    ed.depInput = h("input", { name: "depends-issue", placeholder: "Issue number", autocomplete: "off", "aria-label": "Issue number" });
    ed.previewBox = h("div");
    const addIssue = (e) => {
      const n = issueNumber(ed.depInput.value);
      if (n === null) return void toast("Give the issue number, a whole number from 1.", "error");
      const input = ed.depInput;
      return changeDepends(e.currentTarget, ed.did, (list) => [...list, { issue: n }])?.then((ok) => {
        if (ok) input.value = "";
        return ok;
      });
    };
    const parts = [
      field(d, "title", "input"),
      h("div", { class: "field" }, field(d, "who", "textarea", 2), field(d, "what", "textarea", 2), field(d, "why", "textarea", 2)),
      h("div", { class: "field" }, h("span", {}, "Acceptance criteria"), ed.critList, ed.orphans, ed.sug.get("criteria")),
      field(d, "outOfScope", "textarea", 3),
      h("div", { class: "field" }, h("span", {}, "Depends on"), ed.depList,
        h("div", { class: "row" }, ed.depInput, h("button", { onClick: addIssue }, "Add issue")), ed.depChoose, ed.sug.get("dependsOn")),
      field(d, "notes", "textarea", 3),
    ];
    boxes.editor.replaceChildren(...nodes(h("div", { class: "card" }, ed.hint, ed.partsBox, ed.reviewBox, parts, ed.statusEl, h("div", { class: "row" }, removeDraftButton(d.id), ed.mergeBox), ed.readyBox, ed.previewBox, ed.impactBox, ed.splitBox)));
    for (const k of keysOf(d.id)) if (placeOf(k)) plan(k); // text that waited for this editor is saved
  };

  const NOT_ASKED = "Your text could not be saved, so the architect was not asked. Try again.";
  /** Saves every typed text first; when a save fails nothing is called and `sorry` is the error. */
  const afterSave = (btn, call, sorry) => {
    const saved = flushAll();
    return ctx.send(btn, async () => {
      if ((await Promise.all(saved)).includes(false)) throw Object.assign(new Error(sorry), { status: lastStatus }); // a 401 keeps its status: send then does not reload
      return call();
    });
  };

  /** What the architect's view does: asks for it, and keeps the person's choice about the review label. */
  const impactAct = (did) => ({
    line: ctx.statusLine,
    ask: (btn) => afterSave(btn, () => api.askImpact(sid, did), NOT_ASKED),
    setLabel: (box, add) => ctx.send(box, () => api.setReviewLabel(sid, did, add)).then((ok) => {
      if (!ok) box.checked = !add;
      return ok;
    }),
  });

  /** What the split part does: asks for ways (with an optional own way), redraws after a local change, confirms the plan. */
  const splitAct = (did) => ({
    line: ctx.statusLine,
    redraw: () => update(sess),
    ask: (btn, own) => afterSave(btn, () => api.askSplit(sid, did, own), NOT_ASKED),
    split: (btn, bodyOf) => afterSave(btn, async () => {
      const before = new Set((sess.drafts ?? []).map((x) => x.id));
      const next = await api.confirmSplit(sid, did, bodyOf(draftOf(did)));
      const made = next.drafts?.find((x) => !before.has(x.id));
      if (made) opened.set(sid, made.id);
      return next;
    }, "Your text could not be saved, so nothing was split. Try again."),
  });

  /** What the parts part does: opens a draft, moves a criterion, merges two drafts. Typed text is saved first. */
  const partsAct = (did) => ({
    open: (id) => open(id),
    move: (el, cid, to) => {
      const key = K(did, `crit:${cid}`);
      clearTimeout(timers.get(key));
      timers.delete(key);
      return afterSave(el, () => api.moveCriterion(sid, did, cid, to), "Your text could not be saved, so nothing was moved. Try again.").then((ok) => {
        if (!ok && unsaved.has(key)) plan(key);
        return ok;
      });
    },
    merge: (btn, other) => afterSave(btn, () => {
      // A text of the other draft that has no editor open is not saved by `afterSave`; merging would lose it.
      if (keysOf(other).length) throw new Error("The other draft has text that is not saved. Open it and save it first, so nothing is lost.");
      return api.mergeDrafts(sid, did, other);
    }, "Your text could not be saved, so nothing was merged. Try again."),
  });

  /** What the review box does: asks for a review (the architect must see what is typed). */
  const reviewAct = (did) => ({ line: ctx.statusLine, ask: (btn) => afterSave(btn, () => api.reviewDraft(sid, did), NOT_ASKED) });

  /** What the readiness part does: checks (the architect must see what is typed), accepts an item anyway, removes the reason. */
  const readyAct = (did) => ({
    line: ctx.statusLine,
    ask: (btn) => afterSave(btn, () => api.checkReady(sid, did), "Your text could not be saved, so the draft was not checked. Try again."),
    accept: (btn, row, reason) => ctx.send(btn, () => api.acceptAnyway(sid, did, row.id, reason)),
    remove: (btn, row) => ctx.send(btn, () => api.removeAccepted(sid, did, row.id)),
  });

  /** Moves the text of a field or a criterion to the notes, after a confirmation and after the typed texts are saved. */
  const moveAct = (did, f, row) => ({
    move: (btn) => {
      if (!confirm(MOVE_ASK)) return undefined;
      const keyNow = () => (row ? row.key : K(did, f));
      clearTimeout(timers.get(keyNow()));
      timers.delete(keyNow());
      // No `forget` after the answer: the save before the move cleared the moved text, and text typed meanwhile is newer and stays.
      return afterSave(btn, () => api.moveToNotes(sid, did, row ? { field: "criteria", item: row.id } : { field: f }), "Your text could not be saved, so nothing was moved. Try again.").then((ok) => {
        if (!ok && unsaved.has(keyNow())) plan(keyNow());
        return ok;
      });
    },
  });

  /** What the suggest part of a field does: asks, and takes a suggestion. */
  const sugAct = (did, f) => ({
    line: ctx.statusLine,
    label: LABELS[f],
    // The architect must see what is typed: when a save fails, nothing is asked.
    ask: (btn) => afterSave(btn, () => api.suggestField(sid, did, f), NOT_ASKED),
    hasOther: () => Boolean(String(unsaved.get(K(did, f)) ?? draftOf(did)?.[f]?.text ?? "").trim()),
    accept: (btn, x, text) => {
      const body = text === undefined ? {} : { text };
      if (!TEXT_FIELDS.includes(f)) return ctx.send(btn, () => api.acceptSuggestion(sid, did, x.id, body));
      // Text typed in this field is replaced: no save may bring it back. It is forgotten before the answer is drawn, and planned again after a failure.
      const key = K(did, f);
      clearTimeout(timers.get(key));
      timers.delete(key);
      return ctx.send(btn, () => api.acceptSuggestion(sid, did, x.id, body).then((next) => {
        forget(key);
        return next;
      })).then((ok) => {
        if (!ok && unsaved.has(key)) plan(key);
        return ok;
      });
    },
    reject: (btn, x, reason) => ctx.send(btn, () => api.rejectSuggestion(sid, did, x.id, reason ? { reason } : {})),
  });
  const syncSuggest = (d) => {
    ed.hint.textContent = sess.brief ? "" : NO_BRIEF;
    for (const f of SUGGEST_FIELDS) {
      const key = boxKey(sess, d, f);
      if (key === ed.sugKeys.get(f)) continue;
      ed.sugKeys.set(f, key);
      ed.sug.get(f).replaceChildren(...nodes(suggestNodes(sess, d, f, sugAct(d.id, f))));
    }
    for (const f of ed.marks.keys()) markField(f);
  };

  /** Draws `build()` into `el` only when the key changed. */
  const fillBox = (el, seen, name, key, build) => {
    if (seen.get(name) === key) return;
    seen.set(name, key);
    el.replaceChildren(...nodes(build()));
  };
  const syncRemarks = (d) => {
    for (const [f, el] of ed.rem) fillBox(el, ed.remKeys, f, remarkKey(d, f), () => remarkNodes(d, f, undefined, moveAct(d.id, f)));
    const pk = partsKey(sess, d);
    fillBox(ed.partsBox, ed.remKeys, "parts", pk, () => partsNodes(sess, d, partsAct(d.id)));
    fillBox(ed.mergeBox, ed.remKeys, "merge", pk, () => mergeNodes(sess, d, partsAct(d.id)));
    for (const row of ed.rows.values()) {
      if (row.id && row.mvKey !== pk) {
        row.mvKey = pk;
        row.mv.replaceChildren(...nodes(moveNodes(sess, d, d.criteria.find((c) => c.id === row.id) ?? { id: row.id, text: "" }, partsAct(d.id))));
      }
      if (!row.id) continue;
      const key = remarkKey(d, "criteria", row.id);
      if (row.remKey === key) continue;
      row.remKey = key;
      row.rem.replaceChildren(...nodes(remarkNodes(d, "criteria", row.id, moveAct(d.id, "criteria", row))));
    }
    // Remarks about a criterion that is gone: one group for each criterion, in the order of the review.
    const orphans = orphanRemarks(d);
    fillBox(ed.orphans, ed.remKeys, "orphans", JSON.stringify(orphans), () => [...new Set(orphans.map((r) => r.item))].map((item) => remarkNodes({ review: { remarks: orphans } }, "criteria", item, null)));
    fillBox(ed.reviewBox, ed.remKeys, "review", reviewKey(sess, d), () => reviewNodes(sess, d, reviewAct(d.id)));
    fillBox(ed.impactBox, ed.remKeys, "impact", impactKey(sess, d), () => impactNodes(sess, d, impactAct(d.id)));
    fillBox(ed.readyBox, ed.remKeys, "ready", readyKey(sess, d), () => readyNodes(sess, d, readyAct(d.id)));
    if (ed.remKeys.get("split") !== splitKey(sess, d)) {
      ed.remKeys.set("split", splitKey(sess, d));
      mount(ed.splitBox, splitNodes(sess, d, splitAct(d.id)));
    }
  };

  const syncEditor = (d) => {
    for (const [f, el] of ed.fields) {
      if (unsaved.has(K(d.id, f)) || el === document.activeElement) continue;
      const v = d[f]?.text ?? "";
      if (el.value !== v) el.value = v;
    }
    syncCriteria(d);
    renderDepends(d);
    syncSuggest(d);
    syncRemarks(d);
    renderPreview(d);
  };

  // ---- the page ----
  const open = (id) => {
    flushAll();
    if (id) opened.set(sid, id);
    else opened.delete(sid);
    update(sess);
  };
  const listNodes = (drafts, mine) => {
    if (!drafts.length) return h("p", { class: "muted" }, "No story drafts yet.");
    const openId = opened.get(sid);
    return h("ul", {}, drafts.map((d) => h("li", { class: "entry" }, h("span", {}, draftTitle(d)), h("span", { class: `pill state-${d.state}` }, draftStateText(d)),
      d.published ? h("span", { class: "muted" }, "On GitHub: ", issueLink(d)) : null,
      mine ? h("button", { "data-focus": `open-${d.id}`, onClick: () => open(openId === d.id ? null : d.id) }, openId === d.id ? "Close" : "Open") : null)));
  };
  const epicNodes = (s, mine) => {
    if (!mine || (s.drafts ?? []).some((d) => d.published)) return s.epic !== undefined ? h("p", {}, `Epic: #${s.epic}`) : null;
    return [
      h("p", {}, s.epic !== undefined ? `Epic: #${s.epic}` : "No Epic set."),
      h("div", { class: "row" }, epicInput,
        h("button", { onClick: (e) => {
          const n = issueNumber(epicInput.value);
          if (n === null) return void toast("Give the issue number of the Epic, a whole number from 1.", "error");
          return ctx.send(e.currentTarget, () => api.setEpic(sid, n).then((next) => {
            epicInput.value = "";
            return next;
          }));
        } }, "Set Epic"),
        s.epic !== undefined ? h("button", { onClick: (e) => ctx.send(e.currentTarget, () => api.setEpic(sid, null)) }, "Clear Epic") : null),
    ];
  };

  const update = (s) => {
    sess = s;
    const mine = mayChange(s);
    const drafts = s.draftsHidden ? [] : s.drafts ?? [];
    // A suggestion or review run that has no open field on this page to show it: its line is at the top.
    const a = s.architect;
    const own = a?.kind === "suggest" || a?.kind === "review" || a?.kind === "impact" || a?.kind === "ready" || a?.kind === "split";
    const here = mine && own && opened.get(sid) === a.draft && drafts.some((x) => x.id === a.draft) && (a.kind === "review" || a.kind === "impact" || a.kind === "ready" || (a.kind === "split" && !drafts.find((x) => x.id === a.draft)?.splitInto) || SUGGEST_FIELDS.includes(a.field));
    const stray = !s.draftsHidden && own && Boolean(a.state) && a.state !== "idle" && !here;
    const strayDraft = stray ? drafts.find((x) => x.id === a.draft) : undefined;
    fill("top", `${Boolean(s.draftsHidden)}|${stray ? JSON.stringify([a, opened.get(sid), draftTitle(strayDraft)]) : ""}`, () => [
      s.draftsHidden ? h("p", { class: "muted" }, DRAFTS_HIDDEN) : null,
      stray ? ctx.statusLine(a) : null,
      stray && a.state === "paused" && mine && strayDraft && !strayDraft.splitInto ? h("p", { class: "muted" }, `Open the draft "${draftTitle(strayDraft)}" to ask again.`) : null,
    ]);
    fill("epic", `${mine}|${s.epic}|${drafts.some((d) => d.published)}`, () => epicNodes(s, mine));
    if (!mine) {
      ed = null;
      memo.editor = null;
      boxes.editor.replaceChildren();
      fill("list", `ro|${s.draftsHidden}|${JSON.stringify([drafts, s.talk?.map, s.readyList])}`, () => (s.draftsHidden ? null : drafts.length ? drafts.map((d) => {
        const n = impactNodes(s, d, null);
        const r = readyNodes(s, d, null);
        const sp = splitNodes(s, d, null);
        const pn = partsNodes(s, d, null);
        return [d.published ? h("p", {}, "On GitHub: ", issueLink(d)) : null, pn.length ? h("div", { class: "card parts" }, pn) : null, previewNodes(d), readOnlyNodes(s, d), r.length ? h("div", { class: "card ready" }, r) : null, n.length ? h("div", { class: "card impact" }, n) : null, sp.length ? h("div", { class: "card split" }, sp) : null];
      }) : listNodes(drafts, false)));
    } else {
      fill("list", `rw|${opened.get(sid)}|${s.state}|${JSON.stringify(drafts.map((d) => [d.id, draftTitle(d), d.state, d.published?.issue]))}`, () => [
        listNodes(drafts, true),
        s.state === "published" ? null : h("div", { class: "row" }, h("button", { onClick: (e) => ctx.send(e.currentTarget, () => api.addDraft(sid).then((next) => {
          const before = new Set((sess.drafts ?? []).map((d) => d.id));
          const added = next.drafts?.find((d) => !before.has(d.id));
          if (added) {
            opened.set(sid, added.id);
            focusTitle = true;
          }
          return next;
        })) }, "New draft")),
      ]);
      const d = drafts.find((x) => x.id === opened.get(sid));
      if (!d) {
        ed = null;
        memo.editor = null;
        boxes.editor.replaceChildren();
      } else if (d.published || d.splitInto) {
        // On GitHub, or split: shown as text only, no fields; the saved texts are the record. A split original is read-only on the server.
        ed = null;
        fill("editor", `pub|${JSON.stringify([d, s.readyList, s.talk?.map])}|${partsKey(s, d)}`, () => h("div", { class: "card" },
          d.published ? h("p", {}, "This story is on GitHub as ", issueLink(d), ". It cannot be changed here.")
            : h("p", {}, "This draft was split. It is kept as a record and cannot be changed; its parts are worked on instead."),
          partsNodes(s, d, partsAct(d.id)).length ? h("div", { class: "parts" }, partsNodes(s, d, partsAct(d.id))) : null,
          d.splitInto ? h("div", { class: "row" }, removeDraftButton(d.id)) : null,
          previewNodes(d), readOnlyNodes(s, d), readyNodes(s, d, null), impactNodes(s, d, null)));
      } else {
        if (memo.editor) {
          memo.editor = null;
          ed = null;
        }
        if (!ed || ed.did !== d.id) buildEditor(d);
        syncEditor(d);
        if (focusTitle) {
          focusTitle = false;
          ed.fields.get("title").focus();
        }
      }
    }
    const lost = [...unsaved].filter(([k]) => k.startsWith(`${sid}${SEP}`) && !placeOf(k));
    fill("lost", `${mine}|${JSON.stringify(lost)}`, () => (lost.length ? h("div", { class: "card" },
      h("b", {}, "Not saved"),
      h("p", { class: "muted" }, "This text could not be saved: its place is gone or the session can no longer be changed. Copy it if you need it."),
      lost.map(([k, text]) => {
        const f = k.split(SEP)[2] ?? "";
        return h("p", { class: "said" }, h("b", {}, `${LABELS[f] ?? (f === "crit:new" ? "New acceptance criterion" : "Acceptance criterion")}: `), text);
      }),
      mine ? h("button", { onClick: () => {
        lost.forEach(([k]) => forget(k));
        update(sess);
      } }, "Discard") : null) : null));
  };

  /** Sends every typed text now, until nothing that has a place is waiting. { ok: false } when a save failed; `lost`: texts of this session with no place on the page. */
  const saveAll = async () => {
    for (let i = 0; i < 5; i++) {
      const done = await Promise.all(flushAll());
      if (done.includes(false)) return { ok: false, lost: 0 };
      if (![...unsaved.keys()].some((k) => k.startsWith(`${sid}${SEP}`) && placeOf(k) && !failed.has(k))) break;
    }
    const left = [...unsaved.keys()].filter((k) => k.startsWith(`${sid}${SEP}`));
    return { ok: !left.some((k) => placeOf(k)), lost: left.filter((k) => !placeOf(k)).length };
  };

  const me = { sid, flush };
  cur = me;
  if (!guarded && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    guarded = true;
    window.addEventListener("beforeunload", beforeLeave);
  }
  const leave = () => {
    for (const k of [...timers.keys()]) if (k.startsWith(`${sid}${SEP}`)) clearTimeout(timers.get(k));
    flushAll();
    if (cur === me) cur = null;
  };
  return { node: root, update, leave, saveAll };
}
