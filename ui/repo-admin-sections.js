// The admin part of the repository view (#/repos/:id): where an admin's record comes from, and the extra sections.
// Only the admin router imports this file, so a user's page never loads it.
import { api } from "./api.js";
import { confirmDialog, h, toast } from "./dom.js";
import { statusSummary } from "./kit/product.js";
import { reposChanged } from "./context.js";
import { ownerText, readyDialog, settingsDialog, transferDialog } from "./admin-repos.js";
import { repoWatcherDialog } from "./watcher-form.js";
import { describeWatcher, watcherStateMark } from "./watchers.js";

/**
 * The source of the repository view for an admin: the record comes from the list of all accounts, with this repository's
 * watchers and the flows (a failed call for them only leaves them out). `me` is the signed-in account's id.
 */
export const adminSource = (me) => ({
  async load(id) {
    const [repos, all, flows] = await Promise.all([api.allRepos(), api.watchers().catch(() => null), api.flows().catch(() => [])]);
    const repo = repos.find((r) => r.id === id) ?? null;
    const foreign = !!repo && repo.owner !== me;
    return {
      repo, foreign, back: foreign ? { label: "Repositories", href: "#/all-repos" } : undefined,
      extra: { watchers: all && all.filter((w) => w.repoId === id), flows },
    };
  },
  foreign: (repo) => repo.owner !== me,
  back: (repo) => (repo.owner !== me ? { label: "Repositories", href: "#/all-repos" } : undefined),
  // the answer of "Generate a new key" is the public record: these keys are kept from the admin record
  keep: ["owner", "settings", "ready", "account", "watcherProblem", "offAppList"],
});

const list = (a) => (Array.isArray(a) && a.length ? a.join(", ") : "—");
const text = (s) => (String(s ?? "").trim() || "—");

/** The settings as they are now on the server, read at Save time so a section never sends old values of another section. */
const currentSettings = (id) => async () => {
  const r = (await api.allRepos()).find((x) => x.id === id);
  if (!r) throw new Error("This repository is gone. Reload the page.");
  return r.settings ?? {};
};

const editSettings = (ctx, name, only, title) =>
  ctx.once(name, async () => {
    ctx.setRepo(await settingsDialog(ctx.repo, { only, title, current: currentSettings(ctx.repo.id) }));
    return ctx.reload();
  });

const unavailable = (what) => h("p", { class: "muted" }, `${what} could not be loaded.`);

function branches(ctx) {
  const { repo, readOnly } = ctx;
  const s = repo.settings;
  if (!s) return unavailable("The settings");
  return [
    statusSummary({ label: "Branches", items: [
      { label: "Main branch", value: text(s.mainBranch) },
      { label: "Develop branch", value: text(s.developBranch) },
      { label: "Protected branches", value: list(s.protectedBranches) },
    ] }),
    readOnly ? null : h("div", { class: "row" },
      h("button", { "data-action": "branches", onClick: editSettings(ctx, "branches", ["mainBranch", "developBranch", "protectedBranches"], "Branches") }, "Edit")),
  ];
}

function runSettings(ctx) {
  const { repo, readOnly } = ctx;
  const s = repo.settings;
  const ready = repo.ready;
  return [
    s
      ? [
        statusSummary({ label: "Run settings", items: [
          { label: "Test command", value: text(s.testCommand) },
          { label: "Docs to update", value: list(s.docs) },
        ] }),
        readOnly ? null : h("div", { class: "row" },
          h("button", { "data-action": "run-settings", onClick: editSettings(ctx, "run-settings", ["testCommand", "docs"], "Run settings") }, "Edit")),
      ]
      : unavailable("The settings"),
    h("div", { class: "field mt-6" },
      h("strong", {}, "Definition of Ready", ready?.isDefault ? " (default)" : ""),
      ready ? h("ol", {}, (ready.items ?? []).map((i) => h("li", {}, i.text))) : unavailable("The Definition of Ready")),
    ready && !readOnly
      ? h("div", { class: "row" }, h("button", { "data-action": "ready-edit", onClick: ctx.once("ready-edit", async () => {
        ctx.setRepo(await readyDialog(ctx.repo));
        return ctx.reload();
      }) }, "Edit Definition of Ready"))
      : null,
  ];
}

function watchers(ctx) {
  const { repo, readOnly, extra } = ctx;
  if (repo.watcherProblem) return h("p", { class: "status bad" }, repo.watcherProblem);
  if (extra.watchers === null) {
    return h("div", { class: "row" }, h("span", { class: "muted" }, "The watchers could not be loaded."),
      h("button", { class: "small", "data-action": "watchers-retry", onClick: ctx.once("watchers-retry", () => ctx.reload()) }, "Retry"));
  }
  const flows = extra.flows;
  // a failed call shows the server's sentence as it is; the view is drawn again either way
  const run = (name, fn) => ctx.once(name, async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, "error");
    }
    return ctx.reload();
  });
  const row = (w) => h("div", { class: "row", "data-watcher": w.id },
    h("a", { class: "mono", href: "#/watchers/" + encodeURIComponent(w.id) }, w.id),
    watcherStateMark(w), describeWatcher(w),
    w.problem ? h("span", { class: "status bad" }, w.problem) : null,
    readOnly ? null : [
      h("button", { class: "small", "data-action": `watcher-toggle-${w.id}`, onClick: run(`watcher-toggle-${w.id}`, () => api.saveRepoWatcher(repo.id, w.id, { enabled: !w.enabled })) },
        w.enabled ? "Disable" : "Enable"),
      h("button", { class: "small", "data-action": `watcher-edit-${w.id}`, onClick: run(`watcher-edit-${w.id}`, () => repoWatcherDialog({ repos: [repo], flows, existing: w })) }, "Edit"),
      h("button", { class: "small danger", "data-action": `watcher-delete-${w.id}`, onClick: run(`watcher-delete-${w.id}`, async () => {
        const ok = await confirmDialog({ title: `Delete watcher ${w.id}?`, text: "The watcher stops checking. You can add it again later.", confirm: "Delete watcher" });
        if (!ok) return;
        await api.removeRepoWatcher(repo.id, w.id);
        toast("Deleted");
      }) }, "Delete"),
    ]);
  return [
    extra.watchers.length ? extra.watchers.map(row) : h("p", { class: "muted" }, "No watchers yet."),
    readOnly ? null : h("div", { class: "row" },
      h("button", { "data-action": "watcher-add", onClick: run("watcher-add", () => repoWatcherDialog({ repos: [repo], flows, existing: null })) }, "+ Add watcher")),
  ];
}

const transfer = (ctx) => {
  const { repo, readOnly } = ctx;
  if (readOnly) return null;
  return h("div", { class: "row" }, "Owner: ", ownerText(repo),
    repo.account?.status === "blocked" ? [" ", h("span", { class: "pill" }, "blocked")] : null,
    h("button", { class: "danger", "data-action": "transfer", onClick: ctx.once("transfer", async () => {
      ctx.setRepo(await transferDialog(repo));
      void reposChanged();
      return ctx.reload();
    }) }, "Transfer"));
};

/** `base` (the sections of the view) with Branches, Run settings and Watchers before the danger section, and Transfer in it. */
export function adminSections(base) {
  const at = base.findIndex((s) => s.id === "danger");
  const show = (ctx) => !!ctx.extra;
  const added = [
    { id: "branches", title: "Branches", show, draw: branches },
    { id: "run-settings", title: "Run settings", show, draw: runSettings },
    { id: "watchers", title: "Watchers", show, draw: watchers },
  ];
  return base.flatMap((s, i) => (i === at ? [...added, { ...s, draw: (ctx) => [s.draw(ctx), transfer(ctx)] }] : [s]));
}
