import { api } from "./api.js";
import { h, toast } from "./dom.js";

// The story drafts of a refinement session: write, save as you type, preview. Every text is set as text, never as HTML.

export const DRAFTS_HIDDEN = "The story drafts are not shown while the repository is not in My repositories.";
export const SAVE_MS = 1000;
const SEP = "\u0001";
const NONE = "None (can be built on its own).";
const LABELS = { title: "Title", who: "As …", what: "I want …", why: "so that …", outOfScope: "Out of scope", notes: "Notes for the builder" };

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
  const out = { epic: null, sentence: "", criteria: null, outOfScope: d?.outOfScope?.text ?? "", notes: d?.notes?.text ?? "", depends: null };
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
    out.depends = tail.startsWith("None (") ? [] : tail.split("\n").map((l) => l.replace(/^- /, ""));
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
    p.depends?.length ? h("ul", {}, p.depends.map((t) => h("li", {}, t))) : h("p", { class: "muted" }, NONE));
}

const dependsItem = (x) => (x.issue !== undefined ? { id: x.id, issue: x.issue } : { id: x.id, draft: x.draft });
const nodes = (v) => [v].flat(Infinity).filter(Boolean);

/**
 * The "Story drafts" part. Returns { node, update(s), leave() }.
 * `ctx`: id of the session; `send(btn, call)` runs a button's change (shows the answer, reloads after a failure);
 * `save(call)` runs a change in turn and shows its answer (a failure is thrown); `errorText(e)`.
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
    row.li.append(removeButton(row));
    ed.rows.set(row.key, row);
    ed.byId.set(id, row);
    ed.newRow = makeRow(null);
    ed.rows.set(ed.newRow.key, ed.newRow);
  };

  /** Sends one typed field; the text stays in `unsaved` until the server has it. */
  const flush = (key) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (!unsaved.has(key) || !can()) return;
    const p = placeOf(key);
    if (!p) return;
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
    ctx.save(run).then(
      (next) => {
        if (next === undefined) return;
        failed.delete(keyNow());
        if (pending()) setStatus("Saving…");
        else if ([...failed].some((k) => unsaved.has(k) && placeOf(k))) setStatus(lastError, true); // another field is still not saved: keep saying so
        else setStatus("Saved");
      },
      (e) => {
        lastError = ctx.errorText(e);
        failed.add(keyNow());
        setStatus(lastError, true);
      });
  };
  const flushAll = () => {
    for (const k of [...unsaved.keys()]) if (k.startsWith(`${sid}${SEP}`)) flush(k);
  };

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
        if (!text.trim()) return void forget(row.key); // an emptied one is not sent; it gets its text back when left
        unsaved.set(row.key, text);
        setStatus("Saving…");
        plan(row.key);
      },
      onBlur: () => {
        if (unsaved.has(row.key)) return flush(row.key);
        return syncRow(row, draftOf(ed?.did));
      } });
    row.li = h("li", { class: "entry" }, row.ta, c ? removeButton(row) : null);
    return row;
  }
  const savedText = (row, d) => d?.criteria.find((c) => c.id === row.id)?.text ?? "";
  const syncRow = (row, d) => {
    if (unsaved.has(row.key) || row.ta === document.activeElement) return;
    const v = savedText(row, d);
    if (row.ta.value !== v) row.ta.value = v;
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
        setStatus("Saving…");
        plan(key);
      },
      onBlur: () => {
        if (unsaved.has(key)) return flush(key);
        const v = draftOf(d.id)?.[f]?.text ?? "";
        if (el.value !== v && el !== document.activeElement) el.value = v;
        return undefined;
      } });
    el.value = unsaved.get(key) ?? d[f]?.text ?? "";
    ed.fields.set(f, el);
    return h("label", { class: "field" }, h("span", {}, LABELS[f]), el);
  };

  const dependsText = (x) => (x.issue !== undefined ? `#${x.issue}` : `${draftTitle(draftOf(x.draft))} (draft)`);
  const changeDepends = (btn, did, make) => {
    const d = draftOf(did);
    if (!d) return undefined;
    return ctx.send(btn, () => api.saveDraft(sid, did, { dependsOn: make(d.dependsOn.map(dependsItem)) }));
  };
  const renderDepends = (d) => {
    const others = (sess.drafts ?? []).filter((o) => o.id !== d.id && !d.dependsOn.some((x) => x.draft === o.id));
    const key = JSON.stringify([d.dependsOn, (sess.drafts ?? []).map((o) => [o.id, draftTitle(o)]), others.length]);
    if (ed.dependsKey === key) return;
    ed.dependsKey = key;
    const select = others.length ? h("select", { "aria-label": "Another draft" }, others.map((o) => h("option", { value: o.id }, draftTitle(o)))) : null;
    if (select) select.value = others[0].id;
    ed.depList.replaceChildren(...nodes(d.dependsOn.length ? h("ul", {}, d.dependsOn.map((x) => h("li", { class: "entry" }, h("span", {}, dependsText(x)),
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

  const buildEditor = (d) => {
    ed = { did: d.id, fields: new Map(), rows: new Map(), byId: new Map(), dependsKey: "" };
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
      h("div", { class: "field" }, h("span", {}, "Acceptance criteria"), ed.critList),
      field(d, "outOfScope", "textarea", 3),
      h("div", { class: "field" }, h("span", {}, "Depends on"), ed.depList,
        h("div", { class: "row" }, ed.depInput, h("button", { onClick: addIssue }, "Add issue")), ed.depChoose),
      field(d, "notes", "textarea", 3),
    ];
    const remove = h("button", { class: "danger", onClick: (e) => {
      if (!confirm("Remove this story draft?")) return undefined;
      const did = ed.did;
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
    boxes.editor.replaceChildren(...nodes(h("div", { class: "card" }, parts, ed.statusEl, h("div", { class: "row" }, remove), ed.previewBox)));
    for (const k of keysOf(d.id)) if (placeOf(k)) plan(k); // text that waited for this editor is saved
  };

  const syncEditor = (d) => {
    for (const [f, el] of ed.fields) {
      if (unsaved.has(K(d.id, f)) || el === document.activeElement) continue;
      const v = d[f]?.text ?? "";
      if (el.value !== v) el.value = v;
    }
    syncCriteria(d);
    renderDepends(d);
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
    return h("ul", {}, drafts.map((d) => h("li", { class: "entry" }, h("span", {}, draftTitle(d)),
      mine ? h("button", { "data-focus": `open-${d.id}`, onClick: () => open(openId === d.id ? null : d.id) }, openId === d.id ? "Close" : "Open") : null)));
  };
  const epicNodes = (s, mine) => {
    if (!mine) return s.epic !== undefined ? h("p", {}, `Epic: #${s.epic}`) : null;
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
    fill("top", String(Boolean(s.draftsHidden)), () => (s.draftsHidden ? h("p", { class: "muted" }, DRAFTS_HIDDEN) : null));
    fill("epic", `${mine}|${s.epic}`, () => epicNodes(s, mine));
    if (!mine) {
      ed = null;
      memo.editor = null;
      boxes.editor.replaceChildren();
      fill("list", `ro|${s.draftsHidden}|${JSON.stringify(drafts)}`, () => (s.draftsHidden ? null : drafts.length ? drafts.map(previewNodes) : listNodes(drafts, false)));
    } else {
      fill("list", `rw|${opened.get(sid)}|${JSON.stringify(drafts.map((d) => [d.id, draftTitle(d)]))}`, () => [
        listNodes(drafts, true),
        h("div", { class: "row" }, h("button", { onClick: (e) => ctx.send(e.currentTarget, () => api.addDraft(sid).then((next) => {
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
        boxes.editor.replaceChildren();
      } else {
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
  return { node: root, update, leave };
}
