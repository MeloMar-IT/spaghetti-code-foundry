import { api } from "./api.js";
import { h, modal, toast } from "./dom.js";
import { mayChange, unsaved } from "./refinement-draft.js";

// Publishing on the session page: the plan, the labels, the confirmation. Every text is set as text, never as HTML.

export const PUBLISH = "Publish";
export const PUBLISH_TITLE = "Publish to GitHub";
export const CONFIRM = "Create the issues";
export const START = "Start building this story";
export const NOTHING_SENT = "Nothing is sent to GitHub until you confirm.";
export const NO_WATCHER = "This repository has no enabled watcher for issues, so no label can start a build from here.";
export const ARCHITECT_BUSY = "The architect is working. You can publish when it is done.";
export const NOT_SAVED = "Your text could not be saved, so nothing was published. Try again.";
export const LOST_ASK = "Some text has no place on the page any more and is not saved. Publish anyway?";
export const NOT_READY_NOW = "No draft is ready to publish now.";
export const ALL_PUBLISHED = "Every story draft is on GitHub.";
export const NOTHING_READY = "Nothing can be published yet.";
export const UNKNOWN = "What is on GitHub now is not known. Reload the page to see it.";
export const NO_READY_YET = "A draft can be published when it is ready.";
export const LABELS_MAX = 20;

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** True when Publish is offered: an own open session with its repository, and a ready draft that is not on GitHub. */
export const canPublish = (s) => mayChange(s) && (s.drafts ?? []).some((d) => d.state === "ready" && !d.published);

/** The drafts that are on GitHub: [{ id, issue, url, title }]. */
export const onGithub = (s) => (s?.drafts ?? []).filter((d) => d.published).map((d) => ({ id: d.id, issue: d.published.issue, url: d.published.url, title: d.preview?.title || d.title?.text || "" }));

/** A dependency of a plan item in words: "#12" or "new issue 2: Title". */
export const dependsText = (dep) => ("issue" in dep ? `#${dep.issue}` : `new issue ${dep.item}: ${dep.title}`);

/** The labels a person may tick: the repository's labels without the build and the review label (any case). */
export const offeredLabels = (plan) => (plan.repoLabels ?? []).filter((l) => !(plan.buildLabel && same(l, plan.buildLabel)) && !(plan.reviewLabel && same(l, plan.reviewLabel)));

/** The build tick box: { label } when there is a watcher; `missing` is the sentence when the repository lacks the label (the box is then shown off and disabled). */
export function buildChoice(plan) {
  const l = plan.buildLabel;
  if (!l) return { why: NO_WATCHER };
  if (!(plan.repoLabels ?? []).some((x) => same(x, l))) return { label: l, missing: `The build label "${l}" does not exist in ${plan.repo}. Create it on GitHub to start a build from here.` };
  return { label: l };
}

/** The review label this draft gets, or "" — only when the draft asked for it. */
export const reviewLabelOf = (plan, s, draftId) => ((s?.drafts ?? []).find((d) => d.id === draftId)?.addReviewLabel === true && plan.reviewLabel ? plan.reviewLabel : "");

/** What makes a draft impossible to create as it is chosen, or "" (the server would refuse the whole publish). */
export function choiceProblem(plan, s, draftId, pick) {
  const d = (s?.drafts ?? []).find((x) => x.id === draftId);
  if (d?.addReviewLabel === true) {
    if (!plan.reviewLabel) return "A draft asks for the review label, but this repository has none. Switch the review label off on the draft.";
    if (!(plan.repoLabels ?? []).some((x) => same(x, plan.reviewLabel))) return `The review label "${plan.reviewLabel}" does not exist in ${plan.repo}. Create it on GitHub or switch it off on the draft.`;
    if (plan.buildLabel && same(plan.reviewLabel, plan.buildLabel) && !pick.startBuilding) return `The review label is also the build label. Tick "${START}" for this story or switch the review label off.`;
  }
  if (pick.startBuilding && buildChoice(plan).missing) return buildChoice(plan).missing;
  if (pick.labels.length > LABELS_MAX) return `Choose at most ${LABELS_MAX} labels for a story.`;
  return "";
}

/** The request body: one entry per draft that will be created. `picks`: draft id → { labels, startBuilding }. */
export const publishBody = (plan, picks) => ({
  drafts: (plan.willCreate ?? []).map((draft) => ({ draft, labels: picks[draft]?.labels ?? [], startBuilding: picks[draft]?.startBuilding === true })),
});

/** The line under a failure: "On GitHub already: #101, #102." or "Nothing is on GitHub yet." */
export function onGithubText(s) {
  const on = onGithub(s);
  return on.length ? `On GitHub already: ${on.map((x) => `#${x.issue}`).join(", ")}.` : "Nothing is on GitHub yet.";
}

const nodes = (v) => [v].flat(Infinity).filter(Boolean);
const checkRow = (input, text) => h("label", { class: "check", style: { display: "flex", gap: "6px", alignItems: "center" } }, input, text);
const box = (props) => {
  const el = h("input", { type: "checkbox", style: { width: "auto" }, ...props });
  if (props.disabled) el.setAttribute("disabled", "");
  return el;
};

/** Asks which labels each story gets and shows the plan. `run(body)` sends it. Resolves true when it was sent. */
function planDialog(plan, s, run) {
  let busy = false;
  return modal(PUBLISH_TITLE, (close) => {
    const choice = buildChoice(plan);
    const offered = offeredLabels(plan);
    const picks = new Map(); // draft id → { labels: () => string[], start: () => boolean }
    const error = h("p", { class: "status bad" });
    const item = (it) => {
      const head = [h("b", {}, it.title)];
      const detail = [
        h("details", {}, h("summary", {}, "Text"), h("pre", {}, it.body)),
        h("h4", {}, "Depends on"),
        it.dependsOn.length ? h("ul", {}, it.dependsOn.map((d) => h("li", {}, dependsText(d)))) : h("p", { class: "muted" }, "None (can be built on its own)."),
      ];
      if (it.state === "on-github" || it.state !== "ready") {
        const note = it.state === "on-github"
          ? h("span", { class: "muted" }, `On GitHub as #${it.issue}`)
          : [h("span", { class: "pill" }, "Not published"), " ", h("span", { class: "said" }, it.reason ?? "")];
        return h("li", { "data-plan": it.draft, value: it.n }, head, " ", note, detail,
          it.labels?.length ? [h("h4", {}, "Labels"), h("p", {}, it.labels.join(", "))] : null);
      }
      const ticks = offered.map((name) => ({ name, input: box({ "data-label": name }) }));
      const review = reviewLabelOf(plan, s, it.draft);
      const start = choice.label ? box({ "data-start": "", ...(choice.missing ? { disabled: true } : {}) }) : null;
      picks.set(it.draft, { labels: () => ticks.filter((t) => t.input.checked).map((t) => t.name), start: () => Boolean(start?.checked) });
      const fixed = review ? box({ checked: true, disabled: true }) : null;
      return h("li", { "data-plan": it.draft, value: it.n }, head,
        detail,
        h("h4", {}, "Labels"),
        ticks.length ? ticks.map((t) => checkRow(t.input, t.name)) : h("p", { class: "muted" }, "This repository has no labels to choose."),
        fixed ? checkRow(fixed, `${review} (review label, the draft asked for it)`) : null,
        start ? [checkRow(start, `${START} — adds the label "${choice.label}"`), choice.missing ? h("p", { class: "muted" }, choice.missing) : null] : null);
    };
    const confirmBtn = plan.willCreate.length ? h("button", { class: "primary", onClick: async () => {
      if (busy) return;
      const read = {};
      for (const [did, p] of picks) read[did] = { labels: p.labels(), startBuilding: p.start() };
      for (const did of plan.willCreate) {
        const problem = choiceProblem(plan, s, did, read[did] ?? { labels: [], startBuilding: false });
        if (problem) return void (error.textContent = problem);
      }
      error.textContent = "";
      busy = true;
      confirmBtn.disabled = true;
      cancel.disabled = true;
      try {
        await run(publishBody(plan, read));
      } finally {
        busy = false;
      }
      close(true);
    } }, CONFIRM) : null;
    const cancel = h("button", { onClick: () => (busy ? undefined : close(undefined)) }, "Cancel");
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("p", {}, `These issues will be created in ${plan.repo}, in this order. ${NOTHING_SENT}`),
      choice.why ? h("p", { class: "muted" }, choice.why) : null,
      h("ol", { class: "plan" }, plan.items.map(item)),
      error,
      h("div", { class: "row" }, h("span", { class: "spacer" }), confirmBtn ?? h("p", { class: "muted" }, NOTHING_READY), cancel));
  }, { busy: () => busy });
}

/**
 * The "Publish" part of the session page. Returns { node, update(s) }.
 * `ctx`: id; `save(call)` runs a change in turn and shows the session it returns; `read()` reads the session as the page shows it;
 * `saveAll()` sends every typed text ({ ok, lost }); `errorText(e)`; `current()` is false after the person left the page.
 */
export function publishSection(ctx) {
  const node = h("section", { class: "publish" });
  let sess = null;
  let failure = "";
  let unknown = false; // the session could not be read again after a publish: what is on GitHub is not known
  let shown = null;
  let busy = false;

  const draw = () => {
    const s = sess;
    node.replaceChildren(...nodes(!mayChange(s) ? null : [
      h("h2", {}, PUBLISH),
      failure ? [h("p", { class: "status bad" }, failure), unknown ? h("p", { class: "muted" }, UNKNOWN) : h("p", { class: "muted" }, onGithubText(s))] : null,
      s.state === "published" ? h("p", { class: "muted" }, ALL_PUBLISHED) : null,
      s.state !== "published" && canPublish(s) && ["queued", "running"].includes(s.architect?.state) ? h("p", { class: "muted" }, ARCHITECT_BUSY) : null,
      s.state !== "published" && canPublish(s) && !["queued", "running"].includes(s.architect?.state)
        ? h("button", { class: "primary", "data-focus": "publish", onClick: (e) => start(e.currentTarget) }, PUBLISH) : null,
      s.state !== "published" && !canPublish(s) && !failure ? h("p", { class: "muted" }, NO_READY_YET) : null,
    ]));
  };
  const update = (s) => {
    sess = s;
    const key = JSON.stringify([canPublish(s), mayChange(s), s.state, s.architect?.state, onGithub(s), failure, unknown]);
    if (key === shown) return;
    shown = key;
    draw();
  };

  const run = async (body) => {
    let error;
    let made;
    let stale = false;
    let fresh = false;
    try {
      await ctx.save(async () => {
        try {
          made = await api.publish(ctx.id, body);
        } catch (e) {
          error = e;
          if (e?.status === 401 && unsaved.size) throw e;
        }
        try {
          const next = await ctx.read();
          fresh = true;
          return next;
        } catch (e) {
          if (!error && made) {
            stale = true; // the issues exist; only the page could not be refreshed
            return undefined;
          }
          throw e;
        }
      });
    } catch (e) {
      error ??= e;
    }
    failure = error ? ctx.errorText(error) : stale ? "The issues are on GitHub, but the page could not be refreshed. Reload the page to see the links." : "";
    unknown = Boolean(failure) && !fresh;
    if (!error) toast(made.created.length === 1 ? "1 issue is on GitHub" : `${made.created.length} issues are on GitHub`);
    if (ctx.current()) update(sess); // the failure line is drawn also when the session did not change
  };

  const start = async (btn) => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      failure = "";
      unknown = false;
      const saved = await ctx.saveAll();
      if (!ctx.current()) return;
      if (!saved.ok) {
        failure = NOT_SAVED;
        return;
      }
      if (saved.lost && !confirm(LOST_ASK)) return;
      if (!canPublish(sess)) {
        failure = NOT_READY_NOW;
        return;
      }
      let plan;
      try {
        plan = await api.publishPlan(ctx.id);
      } catch (e) {
        if (ctx.current()) failure = ctx.errorText(e);
        return;
      }
      if (!ctx.current()) return;
      await planDialog(plan, sess, run);
    } finally {
      busy = false;
      if (ctx.current()) update(sess);
      btn.disabled = false;
    }
  };

  return { node, update };
}
