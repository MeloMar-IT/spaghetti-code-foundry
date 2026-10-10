import { api } from "./api.js";
import { confirmDialog, h, modal, toast } from "./dom.js";
import { mayChange, unsaved } from "./refinement-draft.js";
import { issueLink } from "./refinement-states.js";
import { banner } from "./states.js";

// Publishing on the session page: the plan, the labels, the confirmation. Every text is set as text, never as HTML.

export const PUBLISH = "Publish";
export const PUBLISH_TITLE = "Publish to GitHub";
export const CONFIRM = "Create the issues";
export const CONFIRM_UPDATE = "Update the issue";
export const CONFIRM_BOTH = "Update and create the issues";
export const CONFIRM_REPLACE = "Replace the issue";
export const CONFIRM_CREATE_REPLACE = "Create the issues and replace the original";
export const BY_HAND = "Change by hand: it names the issue by its title.";
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

/** True when Publish is offered: an own open session with its repository, and a ready draft that is not on GitHub, or the replacement of a split issue is due. */
export const canPublish = (s) => mayChange(s) && ((s.drafts ?? []).some((d) => d.state === "ready" && !d.published) || s.source?.replace === "due");

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

/** The drafts a publish writes: the one that updates the issue the session came from, then the ones that are created. */
export const willPublish = (plan) => [...(plan.willUpdate ?? []), ...(plan.willCreate ?? [])];

/** The text of the confirm button. */
export const confirmText = (plan) => {
  if (plan.replaces?.ready) return (plan.willCreate ?? []).length ? CONFIRM_CREATE_REPLACE : CONFIRM_REPLACE;
  return (plan.willUpdate ?? []).length ? ((plan.willCreate ?? []).length ? CONFIRM_BOTH : CONFIRM_UPDATE) : CONFIRM;
};

/** The toast after publishing: `made` is the answer of the server. */
export function doneText(made) {
  if (made.kept) return `Issue #${made.kept.issue} is not changed. Your draft is not published.`;
  const created = made.created?.length ?? 0;
  const issues = created === 1 ? "1 issue is on GitHub" : `${created} issues are on GitHub`;
  const rep = made.replaced;
  if (rep) {
    const phrase = rep.closed === "other" ? `issue #${rep.issue} is replaced; it was closed in another way`
      : rep.closed === "not_planned" ? `issue #${rep.issue} is replaced`
        : `issue #${rep.issue} is not closed: check and close it by hand`;
    return created ? `${issues} and ${phrase}` : phrase[0].toUpperCase() + phrase.slice(1);
  }
  const u = made.updated?.[0];
  if (!u) return issues;
  return created ? `Issue #${u.issue} is updated and ${issues}` : `Issue #${u.issue} is updated`;
}

/**
 * The draft that stands for the issue a session came from: { issue, draft, published } — `draft` is the draft as the page has it, `published`
 * its link once it is on GitHub — or undefined when the session came from no issue or nothing stands for it (the draft is gone or split).
 */
export function updatesOf(s) {
  if (!s?.source) return undefined;
  const d = (s.drafts ?? []).find((x) => x.id === s.source.draft);
  if (!d || d.state === "split" || d.splitInto?.length) return undefined;
  return { issue: s.source.issue, draft: d, published: d.published };
}

/** The request body: one entry per draft that will be written. `picks`: draft id → { labels, startBuilding }. */
export const publishBody = (plan, picks) => ({
  drafts: willPublish(plan).map((draft) => ({ draft, labels: picks[draft]?.labels ?? [], startBuilding: picks[draft]?.startBuilding === true })),
});

export const KEEP_MINE = "Keep mine";
export const KEEP_GITHUB = "Keep GitHub's";
export const CHANGED_HINT = "Keep mine replaces GitHub's version; it is kept, folded, in a comment on the issue. Keep GitHub's writes nothing and publishes none of the stories listed below; your draft stays here.";

/** The question when the issue changed on GitHub. */
export const changedText = (c) => `Issue #${c.issue} changed on GitHub after this session read it. Which version do you keep?`;

/** The request body of a choice: "mine" publishes as chosen; "github" only refreshes the source (no drafts). `seen` is the GitHub version that was shown. */
export const keepBody = (plan, picks, keep) =>
  keep === "github" ? { source: { keep, seen: plan.changedOnGithub.seen } } : { ...publishBody(plan, picks), source: { keep, seen: plan.changedOnGithub.seen } };

/** The two versions side by side. Texts are set as text, never as HTML. */
export function versionsNode(c) {
  const column = (head, v) => h("div", {}, h("h4", {}, head), h("b", {}, v.title), h("pre", {}, v.body));
  return h("div", { "data-versions": "", class: "stack cols-2" }, column("On GitHub now", c.github), column("Yours", c.mine));
}

/** What the dialog says about a split issue that a publish replaces by its parts. */
export const replacesText = (r) => (r.ready
  ? (r.staysOpen
    ? `Issue #${r.issue} is replaced by its parts: issues that depend on it are changed to depend on the parts, and a comment on #${r.issue} names them. #${r.issue} stays open: check it and close it by hand.`
    : `Issue #${r.issue} is replaced by its parts and closed as not planned. Issues that depend on it are changed to depend on the parts, and a comment on #${r.issue} names them.`)
  :`Issue #${r.issue} is replaced by its parts when every part is on GitHub. Nothing changes for it now.`);

/** The replacement in the dialog: the sentence, the 1,000 warning and the dependants. Texts are set as text, never as HTML. */
export function replacesNode(r) {
  const list = r.dependants ?? [];
  return [
    h("p", { "data-replaces": "" }, replacesText(r)),
    r.cut ? h("p", { class: "status bad" }, `This repository has more than 1,000 open issues and pull requests. Some issues that depend on #${r.issue} may be missing.`) : null,
    list.length ? [
      h("h4", {}, `Issues that depend on #${r.issue}`),
      h("ul", { "data-dependants": "" }, list.map((d) => h("li", { "data-dependant": String(d.issue) },
        h("b", {}, `#${d.issue} ${d.title}`),
        d.byHand ? h("p", { class: "muted" }, BY_HAND)
          : [h("h4", {}, "Before"), h("pre", {}, d.before ?? ""), h("h4", {}, "After"), h("pre", {}, d.after ?? "")]))),
    ] : null,
  ];
}

/** The line about a split source issue: how far its replacement is, or "" when it is not replaced by parts. */
export function replaceText(source) {
  const n = source?.issue;
  if (source?.replace === "waiting") return `Issue #${n} is replaced by its parts when every part is on GitHub.`;
  if (source?.replace === "due") return `Issue #${n} is not replaced yet. Publish again to finish.`;
  if (source?.replace !== "done") return "";
  const parts = (source.replacedBy ?? []).map((x) => `#${x}`).join(", ");
  const tail = source.closed === "not_planned" ? "" : source.closed === "other" ? " It was closed on GitHub in another way and is left so." : " It is still open: check it and close it by hand.";
  return `Issue #${n} was replaced by ${parts}.${tail}`;
}

/** The line under a failure: "On GitHub already: #101, #102." or "Nothing is on GitHub yet." */
export function onGithubText(s) {
  const on = onGithub(s);
  return on.length ? `On GitHub already: ${on.map((x) => `#${x.issue}`).join(", ")}.` : "Nothing is on GitHub yet.";
}

/** A publish that stopped half way, by session: { made, rest, error } (draft ids). It stays until every draft of `rest` is on GitHub or gone. */
export const partials = new Map();

/** What a failed publish left: `before` the draft ids that were on GitHub, `wanted` the draft ids sent, `s` the session read back. */
export function partialOf(before, wanted, s) {
  const on = new Set(onGithub(s).map((x) => x.id));
  return { made: wanted.filter((id) => on.has(id) && !before.has(id)), rest: wanted.filter((id) => !on.has(id)) };
}

/** The banner text: "2 of 3 issues are on GitHub: #101 One, #102 Two. Not published: Three. <error>" */
export function partialText(p, s) {
  const title = (id) => { const d = (s?.drafts ?? []).find((x) => x.id === id); return d?.preview?.title || d?.title?.text || "Untitled draft"; };
  const issue = (id) => (s?.drafts ?? []).find((x) => x.id === id)?.published?.issue;
  const made = p.made.filter((id) => issue(id) !== undefined);
  return `${made.length} of ${made.length + p.rest.length} issues are on GitHub${made.length ? `: ${made.map((id) => `#${issue(id)} ${title(id)}`).join(", ")}` : ""}. Not published: ${p.rest.map(title).join(", ")}.${p.error ? ` ${p.error}` : ""}`;
}

const nodes = (v) => [v].flat(Infinity).filter(Boolean);
const checkRow = (input, text) => h("label", { class: "check check-row" }, input, text);
const box = (props) => {
  const el = h("input", { type: "checkbox", class: "fit", ...props });
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
      const head = [h("b", {}, it.title), it.updates !== undefined ? [" ", h("span", { class: "pill" }, `Updates #${it.updates}`)] : null];
      const detail = [
        it.updates !== undefined ? h("p", { class: "muted" }, `The title and text of issue #${it.updates} are replaced. Its labels are kept.`) : null,
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
    const asked = plan.changedOnGithub;
    const buttons = [];
    /** Sends `body(read)`, where `read` is what the person ticked. The ticks are checked first when `check`. */
    const send = (body, check) => async () => {
      if (busy) return;
      const read = {};
      for (const [did, p] of picks) read[did] = { labels: p.labels(), startBuilding: p.start() };
      if (check) {
        for (const did of willPublish(plan)) {
          const problem = choiceProblem(plan, s, did, read[did] ?? { labels: [], startBuilding: false });
          if (problem) return void (error.textContent = problem);
        }
      }
      error.textContent = "";
      busy = true;
      for (const b of buttons) b.disabled = true;
      cancel.disabled = true;
      try {
        await run(body(read));
      } finally {
        busy = false;
      }
      close(true);
    };
    if (asked) {
      buttons.push(
        h("button", { class: "primary", "data-keep": "mine", onClick: send((read) => keepBody(plan, read, "mine"), true) }, KEEP_MINE),
        h("button", { "data-keep": "github", onClick: send(() => keepBody(plan, {}, "github"), false) }, KEEP_GITHUB),
      );
    } else if (willPublish(plan).length || plan.replaces?.ready) buttons.push(h("button", { class: "primary", onClick: send((read) => publishBody(plan, read), true) }, confirmText(plan)));
    const cancel = h("button", { onClick: () => (busy ? undefined : close(undefined)) }, "Cancel");
    return h("div", { class: "stack" },
      asked ? [h("p", { class: "status bad" }, changedText(asked)), versionsNode(asked), h("p", { class: "muted" }, CHANGED_HINT)] : null,
      h("p", {},`These issues will be ${(plan.willUpdate ?? []).length && !(plan.willCreate ?? []).length ? "changed" : "created"} in ${plan.repo}, in this order. ${NOTHING_SENT}`),
      (plan.willUpdate ?? []).length ? h("p", {}, `Issue #${plan.items.find((x) => x.updates !== undefined)?.updates} is updated, not created again.`) : null,
      plan.replaces ? replacesNode(plan.replaces) : null,
      plan.notChanged !== undefined ? h("p", { class: "muted" }, `Issue #${plan.notChanged} is not changed: no story draft stands for it.`) : null,
      choice.why ? h("p", { class: "muted" }, choice.why) : null,
      h("ol", { class: "plan" }, plan.items.map(item)),
      error,
      h("div", { class: "row" }, h("span", { class: "spacer" }), buttons.length ? buttons : h("p", { class: "muted" }, NOTHING_READY), cancel));
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
  let again; // the versions of an issue that changed again while the person was asked

  /** What the page says about the issue the session came from: that the draft updates it, that it was updated, or that it is not changed. */
  const sourceLine = (s) => {
    if (!s.source) return null;
    const replaced = replaceText(s.source);
    if (replaced) return h("p", { class: "muted" }, replaced);
    const u = updatesOf(s);
    if (!u) return h("p", { class: "muted" }, `Issue #${s.source.issue} is not changed.`);
    if (u.published) return h("p", { class: "muted" }, "Updated ", issueLink(u));
    return h("p", { class: "muted" }, `Updates #${u.issue}: ${u.draft.preview?.title || u.draft.title?.text || ""}`);
  };

  /** The unfinished publish of this session, reduced to the drafts that still exist and are not on GitHub; gone when none is left. */
  const partialNow = () => {
    const p = partials.get(ctx.id);
    if (!p) return null;
    const rest = p.rest.filter((id) => { const d = (sess?.drafts ?? []).find((x) => x.id === id); return d && !d.published; });
    if (!rest.length) partials.delete(ctx.id);
    return rest.length ? { ...p, rest } : null;
  };
  const draw = () => {
    const s = sess;
    const partial = partialNow();
    const open = s.state !== "published" || s.source?.replace === "due";
    node.replaceChildren(...nodes(!mayChange(s) ? null : [
      h("h2", {}, PUBLISH),
      sourceLine(s),
      partial ? banner("warn", partialText(partial, s), [{ label: "Retry", focus: "publish-retry", onClick: (e) => start(e.currentTarget) }]) : null,
      failure ? [h("p", { class: "status bad" }, failure), unknown ? h("p", { class: "muted" }, UNKNOWN) : h("p", { class: "muted" }, onGithubText(s))] : null,
      s.state === "published" ? h("p", { class: "muted" }, ALL_PUBLISHED) : null,
      open && canPublish(s) && ["queued", "running"].includes(s.architect?.state) ? h("p", { class: "muted" }, ARCHITECT_BUSY) : null,
      open && canPublish(s) && !["queued", "running"].includes(s.architect?.state)
        ? h("button", { class: "primary", "data-focus": "publish", onClick: (e) => start(e.currentTarget) }, PUBLISH) : null,
      open && !canPublish(s) && !failure ? h("p", { class: "muted" }, NO_READY_YET) : null,
    ]));
  };
  const update = (s) => {
    sess = s;
    const u = updatesOf(s);
    const key = JSON.stringify([canPublish(s), mayChange(s), s.state, s.architect?.state, onGithub(s), failure, unknown, partialNow(), s.source?.issue, s.source?.draft, u?.draft.preview?.title || u?.draft.title?.text, u?.published?.issue, s.source?.replace, s.source?.replacedBy, s.source?.closed]);
    if (key === shown) return;
    shown = key;
    draw();
  };

  const run = async (body) => {
    let error;
    let made;
    let stale = false;
    let fresh = false;
    const before = new Set(onGithub(sess).map((x) => x.id));
    const wanted = (body.drafts ?? []).map((x) => x.draft);
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
    // The issue changed again since the versions were shown: the question is asked again, with the new versions, not as a failure.
    const asksAgain = error?.status === 409 && error.data?.changedOnGithub;
    if (asksAgain) {
      again = error.data.changedOnGithub;
      error = undefined;
    }
    failure = error ? ctx.errorText(error) : stale ? "The issues are on GitHub, but the page could not be refreshed. Reload the page to see the links." : "";
    unknown = Boolean(failure) && !fresh;
    // Some issues were created and the rest failed: a banner lists both and stays until the rest is published or removed.
    if (error && fresh && ctx.current()) {
      const now = partialOf(before, wanted, sess);
      const old = partials.get(ctx.id);
      if (now.rest.length && (now.made.length || old)) {
        partials.set(ctx.id, { made: [...new Set([...(old?.made ?? []), ...now.made])], rest: [...new Set([...(old?.rest ?? []), ...now.rest])], error: failure }); // drafts of the last attempt that are not sent now stay until published or removed
        failure = "";
        if (now.made.length) toast(`${now.made.length} of ${wanted.length} issues are on GitHub`);
      }
    }
    if (!error && !asksAgain) toast(doneText(made));
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
      if (saved.lost && !(await confirmDialog({ title: PUBLISH_TITLE, text: LOST_ASK, confirm: "Publish anyway", danger: false }))) return;
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
      for (;;) {
        again = undefined;
        await planDialog(plan, sess, run);
        if (!again || !ctx.current()) break;
        plan = { ...plan, changedOnGithub: again };
      }
    } finally {
      busy = false;
      if (ctx.current()) update(sess);
      btn.disabled = false;
    }
  };

  return { node, update };
}
