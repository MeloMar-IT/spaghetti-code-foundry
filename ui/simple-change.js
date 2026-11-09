import { api, keepPage } from "./api.js";
import { h, mount } from "./dom.js";
import {
  PICTURE_ACCEPT, TEXT_MAX, answersBody, cardBody, cardEdit, cardItems, changeDraft, changeRepoOf, changesOf, clearChangeDraft, hasUnsentChange,
  openChangeOf, phaseOf, pictureProblem, questionItems, readAsBase64,
} from "./simple-change-model.js";
import { projectName } from "./simple-model.js";
import { ANSWER, CHANGE, WORDS } from "./simple-words.js";

// The Ask for a change page (#/change/<project id>): one change request from the first words to "Yes, build this" or "Not now".
// A small state machine: the page is drawn again when the phase changes or after an action, never by a timer, so a box the person
// types in is not thrown away. Only `thinking` is read again, every `every` ms. All text comes from the word list.

const chars = (s) => [...String(s ?? "")].length;

/**
 * The page for project `id`. Never rejects; returns a cleanup that stops the reads.
 * `a` = the API (repos, changes, change, createChange, answerChange, saveChangeCard, buildChange, laterChange, retryChange).
 */
export async function renderSimpleChange(main, { id, a = api, onName, every = 5000, readFile = readAsBase64 } = {}) {
  const box = h("div", { class: "simple" });
  mount(main, box);
  const projectHref = `#/repos/${encodeURIComponent(id)}`;
  const draft = changeDraft(id);
  let stopped = false;
  let timer;
  let seq = 0; // a read that was started before a newer state is dropped
  let repo = null; // the name the change API takes
  let view = null; // the open request, or null
  let busy = false;
  let message = "";
  let buildRetry = false; // the cards were published but the build did not start: the page offers Yes, build this again
  let readFailed = false;
  let pictures = []; // { name, type, data (base64) }; in memory only
  let pending = 0; // slots taken by files that are still being read
  keepPage(hasUnsentChange);

  const back = (href, label) => h("a", { class: "simple-back", href, "data-focus": "simple-back" }, label);
  const show = (...nodes) => { if (!stopped) mount(box, ...nodes.flat(Infinity)); };
  const status = () => h("p", { class: "muted", role: "status", "aria-live": "polite" }, message);
  const frame = (...nodes) => [back(projectHref, CHANGE.back), h("h1", {}, CHANGE.title), ...nodes];

  // ---- reading ----------------------------------------------------------------------------------------------------

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && !busy && phaseOf(view) === "thinking") timer = setTimeout(poll, every);
  };

  /** Takes a view in: parts of the draft that belong to a phase we left are dropped, then the page is drawn. */
  function apply(v) {
    view = v;
    seq += 1;
    readFailed = false;
    buildRetry = false;
    const phase = phaseOf(view);
    if (phase !== "questions") clearChangeDraft(id, "answers");
    if (phase !== "cards") clearChangeDraft(id, "edit");
    draw();
    schedule();
  }

  async function poll() {
    if (stopped || busy || phaseOf(view) !== "thinking") return;
    const mine = seq;
    try {
      const v = await Promise.resolve().then(() => a.change(view.id));
      if (stopped || busy || mine !== seq) return;
      if (phaseOf(v) !== "thinking") return apply(v);
      if (readFailed) { readFailed = false; draw(); }
    } catch {
      if (stopped || busy || mine !== seq) return;
      if (!readFailed) { readFailed = true; draw(); }
    }
    schedule();
  }

  /**
   * After a call that did not work: the server may have kept it (a lost answer, a step that failed after the answers were saved).
   * The request is read again; when it changed, the page follows it. Otherwise the drafts stay and the failure is told.
   */
  async function reconcile(intent) {
    let fresh = null;
    try {
      if (view) fresh = await Promise.resolve().then(() => a.change(view.id));
      else {
        const typed = draft.text.trim();
        const found = openChangeOf(changesOf(await Promise.resolve().then(() => a.changes(repo))));
        if (found && found.text?.trim() === typed) {
          clearChangeDraft(id, "text");
          fresh = found;
        }
      }
    } catch { /* the outcome is not known: the drafts stay */ }
    if (stopped) return;
    // the cards were published, but the build did not start: say so, and keep the build as the thing to do
    if (intent === "build" && fresh && phaseOf(fresh) === "planned" && fresh.building !== true) {
      view = fresh;
      seq += 1;
      buildRetry = true;
      message = CHANGE.buildFailed;
      draw();
      schedule();
      return;
    }
    const known = view && fresh && fresh.state === view.state && JSON.stringify(fresh.questions ?? fresh.cards ?? null) === JSON.stringify(view.questions ?? view.cards ?? null);
    if (fresh && !known) {
      message = "";
      return apply(fresh);
    }
    message = CHANGE.failed;
    draw();
    schedule();
  }

  /**
   * One action at a time. The boxes are off while it runs. `done` runs when it worked: it clears only the part of the draft that
   * was sent, and only when the person has not changed it since. `intent` is "build" for Yes, build this.
   */
  async function act(fn, done, intent, onError) {
    if (busy || stopped) return;
    busy = true;
    message = "";
    clearTimeout(timer);
    seq += 1;
    draw();
    let v;
    try {
      v = await Promise.resolve().then(fn);
    } catch (e) {
      busy = false;
      // the server refused the request itself: nothing was made, so nothing is read again and the drafts stay
      if (onError?.(e)) { if (!stopped) draw(); return; }
      return reconcile(intent);
    }
    busy = false;
    if (stopped) return;
    done?.();
    apply(v);
  }

  // ---- drawing ----------------------------------------------------------------------------------------------------

  /**
   * Takes the chosen files in. The slots are reserved before anything is read, so two choices that overlap never go over the limit,
   * and a file that fails to read gives its slot back.
   */
  async function pick(input) {
    const files = [...(input.files ?? [])];
    input.value = "";
    const notes = [];
    const accepted = [];
    for (const f of files) {
      const problem = pictureProblem(f, pictures.length + pending);
      const name = String(f?.name ?? "");
      if (problem) notes.push({ many: CHANGE.pictureTooMany, empty: CHANGE.pictureEmpty, big: CHANGE.pictureTooBig, type: CHANGE.pictureWrongType }[problem](name));
      else { pending += 1; accepted.push(f); }
    }
    message = notes.join(" ");
    draw();
    if (!accepted.length) return;
    const got = await Promise.all(accepted.map(async (f) => {
      try {
        return { f, data: await readFile(f) };
      } catch {
        return { f, data: null };
      }
    }));
    if (stopped) return;
    const failed = [];
    for (const { f, data } of got) {
      pending -= 1;
      if (typeof data === "string" && data) pictures.push({ name: String(f.name ?? ""), type: f.type, data });
      else failed.push(CHANGE.pictureReadFailed(String(f.name ?? "")));
    }
    message = [...notes, ...failed].join(" ");
    draw();
  }

  function picturesBlock() {
    const off = busy ? true : undefined;
    return [
      h("label", { for: "change-pictures" }, CHANGE.picturesLabel),
      h("p", { class: "muted" }, CHANGE.picturesHint),
      h("input", { type: "file", id: "change-pictures", accept: PICTURE_ACCEPT, multiple: true, disabled: off, "data-focus": "change-pictures", onChange: (e) => { void pick(e?.target ?? e?.currentTarget ?? {}); } }),
      pictures.length ? h("ul", { class: "simple-list" }, pictures.map((p, i) => h("li", { class: "simple-card" },
        h("img", { class: "simple-picture", src: `data:${p.type};base64,${p.data}`, alt: CHANGE.pictureAlt(i + 1, p.name) }),
        h("button", {
          type: "button", class: "btn", disabled: off, "aria-label": CHANGE.pictureRemove(i + 1), "data-focus": `change-picture-remove-${i + 1}`,
          onClick: () => { pictures.splice(i, 1); message = ""; draw(); },
        }, CHANGE.remove)))) : null,
    ];
  }

  function writeView() {
    const text = h("textarea", { id: "change-text", rows: 8, "data-focus": "change-text", value: draft.text, disabled: busy ? true : undefined, onInput: () => { draft.text = String(text.value ?? ""); } });
    draft.text = String(text.value ?? draft.text);
    const send = () => {
      const t = String(text.value ?? "").trim();
      draft.text = String(text.value ?? "");
      if (!t) { message = CHANGE.needsText; return draw(); }
      if (chars(t) > TEXT_MAX) { message = CHANGE.tooLongText(chars(t)); return draw(); }
      if (pending > 0) return;
      const sent = draft.text;
      const withPictures = pictures.length > 0;
      const body = withPictures ? { repo, text: t, pictures: pictures.map((p) => p.data) } : { repo, text: t };
      return act(
        () => a.createChange(body),
        () => { if (draft.text === sent) clearChangeDraft(id, "text"); pictures = []; },
        undefined,
        (e) => {
          if (!withPictures || e?.status !== 400) return false;
          message = CHANGE.picturesRefused;
          return true;
        });
    };
    return [
      h("label", { for: "change-text" }, CHANGE.what), text,
      h("p", { class: "muted" }, CHANGE.hint),
      picturesBlock(),
      status(),
      h("p", {}, h("button", { type: "button", class: "btn primary simple-big", disabled: busy || pending > 0 ? true : undefined, "data-focus": "change-send", onClick: send }, busy ? CHANGE.sending : CHANGE.send)),
    ];
  }

  function thinkingView() {
    const rows = [0, 1, 2].map(() => h("div", { class: "skeleton-row", "aria-hidden": "true" }));
    return [
      h("p", { role: "status" }, CHANGE.thinking),
      h("div", { class: "skeleton skeleton-list", "aria-hidden": "true" }, rows),
      readFailed ? h("p", { class: "muted", role: "status" }, CHANGE.readFailed) : null,
    ];
  }

  function questionsView() {
    const items = questionItems(view);
    const send = () => {
      const r = answersBody(view.questions, draft.answers);
      if (r.missing) { message = ANSWER.needs(r.missing); return draw(); }
      if (r.tooLong) { message = CHANGE.tooLongAnswer(r.tooLong); return draw(); }
      const sent = JSON.stringify(draft.answers);
      return act(() => a.answerChange(view.id, r.body), () => { if (JSON.stringify(draft.answers) === sent) clearChangeDraft(id, "answers"); });
    };
    const fieldsets = items.map((q) => {
      const mine = (draft.answers[q.id] ??= {});
      if (mine.option === undefined) mine.option = q.options.find((o) => o.recommended)?.n;
      const choose = (n) => () => { mine.option = n; };
      const own = h("textarea", {
        rows: 2, "aria-label": ANSWER.yourAnswer(q.n), placeholder: CHANGE.yourOwn, "data-focus": `change-own-${q.n}`, value: mine.text ?? "", disabled: busy ? true : undefined,
        onInput: () => { mine.text = String(own.value ?? ""); },
      });
      return h("fieldset", {},
        h("legend", {}, `${ANSWER.question(q.n)}: ${q.text}`),
        q.why ? h("p", { class: "muted" }, q.why) : null,
        q.options.map((o) => h("p", {}, h("label", {},
          h("input", { type: "radio", name: `change-q-${q.n}`, value: String(o.n), checked: mine.option === o.n, disabled: busy ? true : undefined, "data-focus": `change-option-${q.n}-${o.n}`, onChange: choose(o.n), onClick: choose(o.n) }),
          ` ${o.text}`, o.recommended ? ` (${CHANGE.suggested})` : ""))),
        own);
    });
    return [
      h("p", {}, CHANGE.questionsIntro), fieldsets, status(),
      h("p", {}, h("button", { type: "button", class: "btn primary simple-big", disabled: busy ? true : undefined, "data-focus": "change-answers", onClick: send }, busy ? ANSWER.sending : ANSWER.send)),
    ];
  }

  /** The boxes of a card edit. They show filtered text; what the person did not touch is sent as the server has it. */
  function editView(raw) {
    const edit = cardEdit(raw);
    const mine = draft.edit;
    const visible = edit.slots.filter((s) => s.shown);
    const values = mine.values ?? { title: edit.title, criteria: visible.map((s) => s.shown), added: "" };
    mine.values = values;
    const off = busy ? true : undefined;
    const title = h("input", { type: "text", id: "change-title", "data-focus": "change-title", value: values.title, disabled: off });
    const boxes = visible.map((s, i) => h("textarea", { id: `change-point-${i}`, rows: 2, "data-focus": `change-point-${i}`, value: values.criteria[i] ?? s.shown, disabled: off }));
    const added = h("textarea", { id: "change-point-new", rows: 2, "data-focus": "change-point-new", value: values.added, disabled: off });
    const read = () => ({ title: String(title.value ?? ""), criteria: boxes.map((b) => String(b.value ?? "")), added: String(added.value ?? "") });
    const track = () => {
      mine.values = read();
      mine.dirty = mine.values.title !== edit.title || mine.values.criteria.some((v, i) => v !== visible[i].shown) || mine.values.added.trim() !== "";
    };
    for (const el of [title, ...boxes, added]) el.addEventListener("input", track);
    const save = () => {
      track();
      const r = cardBody(edit, mine.values);
      if (r.problem) { message = r.problem; return draw(); }
      if (r.unchanged) { clearChangeDraft(id, "edit"); message = ""; return draw(); }
      const sent = JSON.stringify(mine.values);
      return act(() => a.saveChangeCard(view.id, edit.did, r.body), () => { if (JSON.stringify(draft.edit?.values) === sent) clearChangeDraft(id, "edit"); });
    };
    return h("li", { class: "simple-card" },
      h("p", {}, h("label", { for: "change-title" }, CHANGE.titleLabel), title),
      boxes.map((b, i) => h("p", {}, h("label", { for: `change-point-${i}` },CHANGE.criterionLabel(i + 1)), b)),
      h("p", {}, h("label", { for: "change-point-new" }, CHANGE.newCriterionLabel), added),
      h("p", {},
        h("button", { type: "button", class: "btn primary", disabled: busy ? true : undefined, "data-focus": "change-save", onClick: save }, CHANGE.save),
        h("button", { type: "button", class: "btn", disabled: busy ? true : undefined, "data-focus": "change-cancel", onClick: () => { clearChangeDraft(id, "edit"); message = ""; draw(); } }, CHANGE.cancel)));
  }

  function cardsView() {
    const items = cardItems(view);
    const editing = draft.edit !== null && items.some((c) => c.id === draft.edit.did);
    if (!editing) draft.edit = null;
    const off = busy || editing ? true : undefined;
    const list = items.map((c, i) => {
      if (editing && draft.edit.did === c.id) return editView(view.cards[i]);
      return h("li", { class: "simple-card" },
        h("h3", {}, c.title),
        h("p", {}, c.understood),
        c.criteria.length ? [h("p", { class: "muted" }, CHANGE.criteriaTitle), h("ul", {}, c.criteria.map((x) => h("li", {}, x)))] : null,
        h("p", {}, h("button", {
          type: "button", class: "btn", disabled: off, "data-focus": `change-edit-${c.id}`,
          onClick: () => { draft.edit = { did: c.id, values: null, dirty: false }; message = ""; draw(); },
        }, CHANGE.change)));
    });
    const decide = (call, intent) => () => {
      if (draft.edit) { message = CHANGE.saveFirst; return draw(); }
      return act(call, null, intent);
    };
    return [
      h("h2", {}, CHANGE.cardsTitle),
      h("ul", { class: "simple-list" }, list),
      status(),
      h("p", {},
        h("button", { type: "button", class: "btn primary simple-big", disabled: off, "data-focus": "change-build", onClick: decide(() => a.buildChange(view.id), "build") }, CHANGE.build),
        h("button", { type: "button", class: "btn simple-big", disabled: off, "data-focus": "change-later", onClick: decide(() => a.laterChange(view.id)) }, CHANGE.later)),
    ];
  }

  function plannedView() {
    if (buildRetry) {
      // published, but not started: the person can try the build again; "kept for later" would be wrong here
      return [
        status(),
        h("p", {}, h("button", { type: "button", class: "btn primary simple-big", disabled: busy ? true : undefined, "data-focus": "change-build", onClick: () => act(() => a.buildChange(view.id), null, "build") }, busy ? CHANGE.sending : CHANGE.build)),
        h("p", {}, h("a", { class: "btn", href: projectHref, "data-focus": "change-project" }, CHANGE.back)),
      ];
    }
    return [
      h("p", { role: "status" }, view.building === true ? CHANGE.onItsWay : CHANGE.kept),
      h("p", {}, h("a", { class: "btn", href: projectHref, "data-focus": "change-project" }, CHANGE.back)),
      h("p", {}, h("button", {
        type: "button", class: "btn primary simple-big", "data-focus": "change-another",
        onClick: () => { view = null; buildRetry = false; message = ""; seq += 1; clearChangeDraft(id); draw(); },
      }, CHANGE.another)),
    ];
  }

  function stuckView() {
    return [
      h("p", { role: "status" }, CHANGE.stuck), status(),
      h("p", {}, h("button", { type: "button", class: "btn primary simple-big", disabled: busy ? true : undefined, "data-focus": "change-retry", onClick: () => act(() => a.retryChange(view.id)) }, CHANGE.retry)),
    ];
  }

  function draw() {
    const phase = phaseOf(view);
    const body = { write: writeView, thinking: thinkingView, questions: questionsView, cards: cardsView, planned: plannedView, stuck: stuckView }[phase]();
    show(...frame(body));
  }

  // ---- start ------------------------------------------------------------------------------------------------------

  async function start() {
    const failed = () => show(h("div", { role: "alert" }, h("p", {}, CHANGE.loadFailed), h("p", {}, h("button", { type: "button", "data-focus": "change-reload", onClick: () => { void start(); } }, CHANGE.retry))));
    let repos;
    let list;
    try {
      repos = await Promise.resolve().then(() => a.repos());
      const all = Array.isArray(repos) ? repos : [];
      const project = all.find((r) => String(r.id) === String(id));
      if (!project) return show(back("#/home", WORDS.back), h("p", {}, WORDS.notFound));
      repo = changeRepoOf(project);
      if (!repo) return show(back(projectHref, CHANGE.back), h("p", {}, CHANGE.noPlace));
      onName?.(projectName(project, all));
      list = await Promise.resolve().then(() => a.changes(repo));
    } catch {
      return failed();
    }
    if (stopped) return;
    view = openChangeOf(changesOf(list));
    apply(view);
  }

  await start();
  return () => {
    stopped = true;
    clearTimeout(timer);
    keepPage(null);
  };
}
