import { expect, test, type Browser, type Page } from "@playwright/test";
import { apiAs, openAs, type Api, type Role } from "./helpers.js";
import { journey } from "./journey.js";
import { BASELINE, KNOWN_OVER, over, REDESIGN, type Counts, type TaskId } from "./journeys-baseline.js";

// The five audit tasks of docs/ui-redesign/measurement.md, walked in the real UI with the seeded data. Each task
// uses its own item (started through the API) so the other specs still find "Seeded gate run". The effort is counted
// by journey.ts and compared with the baseline in journeys-baseline.ts.

const W = 1440;
// Built from parts, as seed.ts does: no literal token in the repository.
const TOKEN = ["github", "pat", ""].join("_") + "Qw7".repeat(12);

/** The shared ending: the measure is the one in REDESIGN, and it is not above the baseline (unless a follow-up is named). */
function settle(id: TaskId, counts: Counts): void {
  expect(counts, "REDESIGN in journeys-baseline.ts is what this test measures").toEqual(REDESIGN[id]);
  const gap = over(counts, BASELINE[id]);
  test.fixme(gap.length > 0 && !!KNOWN_OVER[id], KNOWN_OVER[id]);
  expect(gap, `task ${id} is longer than the baseline`).toEqual([]);
}

async function startRun(api: Api, flow: string, task: string, status: string): Promise<string> {
  const res = await api.send("POST", "/api/runs", { flow, task });
  expect(res.status(), `start the ${flow} run`).toBe(201);
  const { runId } = (await res.json()) as { runId: string };
  await expect.poll(async () => ((await (await api.send("GET", `/api/runs/${runId}`)).json()) as { status: string }).status, { timeout: 20_000 }).toBe(status);
  return runId;
}

async function withPage(browser: Browser, role: Role, hash: string, body: (page: Page, api: Api) => Promise<void>): Promise<void> {
  const api = await apiAs(role);
  const page = await openAs(browser, role, W, hash);
  try {
    await body(page, api);
  } finally {
    await page.context().close();
    await api.close();
  }
}

test.describe("the five tasks", () => {
  test("1 Start work", async ({ browser }) => {
    await withPage(browser, "user", "", async (page, api) => {
      const j = await journey(page);
      await j.click(page.locator('#top-actions a[data-nav="start"]'), { opens: "page" });
      const task = page.locator('textarea[name="task"]');
      await j.click(task);
      await j.fill(task, "Journey 1 start work");
      await j.click(page.getByRole("button", { name: "Start", exact: true }), { opens: "page" });
      try {
        await expect(page).toHaveURL(/#\/runs\/[\w-]+$/);
        await expect(page.locator("#main")).toContainText("Journey 1 start work");
        settle(1, await j.finish());
      } finally {
        const id = /#\/runs\/([\w-]+)$/.exec(page.url())?.[1];
        if (id) await api.send("POST", `/api/runs/${id}/cancel`, {}).catch(() => undefined);
      }
    });
  });

  test("2 Approve a waiting run", async ({ browser }) => {
    // Your turn offers Approve only for a run that a watcher started for a GitHub issue (src/your-turn.ts actsFor), and the
    // harness runs without watchers. A run started by hand shows only a link to its run page, so the dialog and the toast
    // of the end state cannot be reached. Needs a watcher-backed fixture (a fake issue and a watcher tick): open point.
    test.fixme(true, "Approve in Your turn needs a watcher-backed gate run (fake issue + watcher tick); the harness has none");
    await withPage(browser, "admin", "", async (page, api) => {
      const task = "Journey 2 approve";
      await startRun(api, "gate", task, "waiting");
      const j = await journey(page);
      const item = page.locator(".turn-item", { hasText: task });
      await j.click(item.getByRole("button", { name: "Show request" }), { opens: "dialog" });
      await j.click(page.getByRole("dialog").getByRole("button", { name: "Approve" }));
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page.locator("#toast")).toContainText("Done — continuing");
      settle(2, await j.finish());
    });
  });

  test("3 Diagnose a failed run", async ({ browser }) => {
    await withPage(browser, "admin", "", async (page, api) => {
      const task = "Journey 3 diagnose";
      await startRun(api, "fail", task, "failed");
      await page.reload();
      await expect(page.locator("#main")).toHaveAttribute("aria-label", /.+/);
      const j = await journey(page);
      await j.click(page.locator('#side a[data-nav="runs"]'), { opens: "page" });
      await j.click(page.locator("tr.link", { hasText: task }), { opens: "page" });
      // The failing step is already open when the run page shows: no click is needed.
      const step = page.locator("details.tl", { hasText: "check" }).first();
      await expect(step).toHaveJSProperty("open", true);
      await expect(step.locator("pre").first()).toContainText("broken");
      settle(3, await j.finish());
    });
  });

  test("4 Add a repository", async ({ browser }) => {
    await withPage(browser, "user", "", async (page, api) => {
      const j = await journey(page);
      let added: string | undefined;
      try {
        await j.click(page.locator('#side a[data-nav="repos"]'), { opens: "page" });
        await j.click(page.getByRole("button", { name: "+ Add repository" }), { opens: "dialog" });
        const dialog = page.getByRole("dialog");
        await j.fill(dialog.locator('input[name="url"]'), "https://github.com/example/new-app");
        const token = dialog.locator('input[name="token"]');
        await j.click(token);
        await j.fill(token, TOKEN);
        await j.click(dialog.getByRole("button", { name: "Add repository" }));
        await expect(page.locator("#toast")).toContainText("Repository added");
        await expect(page.locator("#main")).toContainText("example/new-app");
        added = "example/new-app";
        settle(4, await j.finish());
      } finally {
        if (added) {
          const list = (await (await api.send("GET", "/api/repos")).json()) as { id: string; name?: string; url?: string }[] | { repos: { id: string; name?: string; url?: string }[] };
          const repos = Array.isArray(list) ? list : list.repos;
          for (const r of repos.filter((x) => JSON.stringify(x).includes("example/new-app"))) await api.send("DELETE", `/api/repos/${r.id}`).catch(() => undefined);
        }
      }
    });
  });

  test("5 Refine an idea into a story draft", async ({ browser }) => {
    await withPage(browser, "user", "", async (page, api) => {
      const j = await journey(page);
      try {
        await j.click(page.locator('#side a[data-nav="refinement"]'), { opens: "page" });
        await j.click(page.getByRole("button", { name: "New session" }), { opens: "dialog" });
        const idea = page.getByRole("dialog").locator('textarea[name="idea"]');
        await j.click(idea);
        await j.fill(idea, "Journey 5 refine an idea");
        await j.click(page.getByRole("dialog").getByRole("button", { name: "Start session" }), { opens: "page" });
        await j.click(page.getByRole("button", { name: "New draft" }));
        await j.fill(page.locator('[data-focus="field-title"]'), "Build status on the board");
        await expect(page).toHaveURL(/#\/refinement\/[\w-]+$/);
        await expect(page.locator("#main")).toContainText("Build status on the board");
        settle(5, await j.finish());
      } finally {
        const id = /#\/refinement\/([\w-]+)$/.exec(page.url())?.[1];
        if (id) await api.send("POST", `/api/refinement/${id}/drop`, {}).catch(() => undefined);
      }
    });
  });
});

test.describe("the counter", () => {
  const SHORT = { wait: 700 };

  test("counts a click and a fill on a focused box", async ({ page }) => {
    await page.setContent('<input id="a">');
    const j = await journey(page, SHORT);
    await j.click(page.locator("#a"));
    await j.fill(page.locator("#a"), "x");
    expect(await j.finish()).toEqual({ nav: 0, clicks: 1, fields: 1 });
  });

  test("a fill on a box without the focus fails", async ({ page }) => {
    await page.setContent('<input id="a">');
    const j = await journey(page, SHORT);
    await expect(j.fill(page.locator("#a"), "x")).rejects.toThrow();
  });

  test("a declared page change and a goto are navigation steps", async ({ page }) => {
    await page.setContent('<a href="#/x">x</a>');
    const j = await journey(page, SHORT);
    await j.click(page.locator("a"), { opens: "page" });
    await j.goto("#/y");
    expect(await j.finish()).toEqual({ nav: 2, clicks: 1, fields: 0 });
  });

  test("a declared dialog is a navigation step", async ({ page }) => {
    await page.setContent('<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<div role=dialog>d</div>\')">open</button>');
    const j = await journey(page, SHORT);
    await j.click(page.locator("button"), { opens: "dialog" });
    expect(await j.finish()).toEqual({ nav: 1, clicks: 1, fields: 0 });
  });

  test("a page change that was not declared fails finish()", async ({ page }) => {
    await page.setContent('<a href="#/x">x</a>');
    const j = await journey(page, SHORT);
    await page.locator("a").click();
    await expect.poll(() => page.evaluate(() => window.__journey?.pages)).toBe(1);
    await expect(j.finish()).rejects.toThrow(/did not declare/);
  });

  test("a dialog that was not declared fails finish()", async ({ page }) => {
    await page.setContent('<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<div role=dialog>d</div>\')">open</button>');
    const j = await journey(page, SHORT);
    await j.click(page.locator("button"));
    await expect.poll(() => page.evaluate(() => window.__journey?.dialogs)).toBe(1);
    await expect(j.finish()).rejects.toThrow(/did not declare/);
  });

  test("a click that declares a dialog fails when none shows", async ({ page }) => {
    await page.setContent("<button>b</button>");
    const j = await journey(page, SHORT);
    await expect(j.click(page.locator("button"), { opens: "dialog" })).rejects.toThrow();
  });
});
