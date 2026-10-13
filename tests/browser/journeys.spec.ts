import { expect, test, type Browser, type Page } from "@playwright/test";
import { apiAs, cancelRuns, isStart, onlyNote, openAs, seed, startedId, startRun, type Api, type ApiResponse, type OpenOptions, type Role } from "./helpers.js";
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

async function withPage(browser: Browser, role: Role, hash: string, body: (page: Page, api: Api) => Promise<void>, opts: OpenOptions = {}): Promise<void> {
  const api = await apiAs(role, opts.large ? "large" : "default");
  let page: Page | undefined;
  try {
    page = await openAs(browser, role, W, hash, opts);
    await body(page, api);
  } finally {
    await page?.context().close();
    await api.close();
  }
}

test.describe("the five tasks", () => {
  test("1 Start work", async ({ browser }) => {
    // Runs on the large server, where the published `note` flow exists; the flow list is cut to it so the page offers one flow.
    expect(seed("large").noteFlow).toBe("note");
    const TASK = "Journey 1 start work";
    await withPage(browser, "user", "", async (page, api) => {
      await onlyNote(page);
      // the id comes from the answer to the start request, wherever the page ends up
      let posted: Promise<string | undefined> = Promise.resolve(undefined);
      page.on("response", (r) => { if (isStart(r.request())) posted = startedId(r); });
      try {
        const j = await journey(page);
        await j.click(page.locator('#top-actions a[data-nav="start"]'), { opens: "page" });
        const task = page.locator('textarea[name="task"]');
        await j.click(task);
        await j.fill(task, TASK);
        await j.click(page.getByRole("button", { name: "Review", exact: true }));
        await j.click(page.getByRole("button", { name: "Start", exact: true }), { opens: "page" });
        await expect(page).toHaveURL(/#\/runs\/[\w-]+$/);
        await expect(page.locator("#main")).toContainText(TASK);
        settle(1, await j.finish());
      } finally {
        const id = await posted;
        if (id) await api.send("POST", `/api/runs/${id}/cancel`, {}).catch(() => undefined);
        await cancelRuns(api, TASK);
      }
    }, { large: true });
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
      await j.click(page.locator("li.run-card", { hasText: task }), { opens: "page" });
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
        await j.click(dialog.getByRole("button", { name: "Next" }));
        // Next puts the focus on the token: no click on it
        await j.fill(dialog.locator('input[name="token"]'), TOKEN);
        await j.click(dialog.getByRole("button", { name: "Add repository" }));
        // the dialog tests the connection by itself; Done comes when the test has answered
        await j.click(dialog.getByRole("button", { name: "Done" }));
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

test.describe("the clean-up", () => {
  test("cancelRuns cancels a queued job that has no run record", async () => {
    const task = "Clean-up task";
    const calls: string[] = [];
    const answers: Record<string, unknown> = {
      "/api/queue": { pending: [{ runId: "q-1", task }, { runId: "q-2", task: "Other" }, { runId: "q-3", task }, { runId: "q-4", task }], active: [] },
      "running": [{ runId: "r-1", task }, { runId: "r-x", task: "Other" }],
      "waiting": [{ runId: "w-1", task }],
    };
    const reply = (status: number, body: unknown): ApiResponse => ({ status: () => status, json: async () => body });
    const api: Api = {
      send: async (method, path) => {
        if (method === "GET") return reply(200, answers[path] ?? answers[new URL(path, "http://x").searchParams.get("status") ?? ""]);
        calls.push(path);
        // the first cancel answers 500 and the second request is rejected: the others are still tried, and both are reported
        if (path === "/api/runs/q-3/cancel") throw new Error("socket hang up");
        return reply(path === "/api/runs/q-1/cancel" ? 500 : 200, {});
      },
      close: async () => undefined,
    };
    await expect(cancelRuns(api, task)).rejects.toThrow(/q-1 \(500\).*q-3 \(socket hang up\)/);
    expect(calls).toEqual(["/api/runs/q-1/cancel", "/api/runs/q-3/cancel", "/api/runs/q-4/cancel", "/api/runs/r-1/cancel", "/api/runs/w-1/cancel"]);
  });

  test("cancelRuns drains more than 200 waiting runs, filtered by the task", async () => {
    const task = "Many waiting";
    const open = new Set(Array.from({ length: 450 }, (_, i) => `w-${i}`));
    const queries: string[] = [];
    const reply = (body: unknown): ApiResponse => ({ status: () => 200, json: async () => body });
    const api: Api = {
      send: async (method, path) => {
        if (method === "POST") {
          open.delete(/\/api\/runs\/([^/]+)\/cancel/.exec(path)?.[1] ?? "");
          return reply({});
        }
        if (path === "/api/queue") return reply({ pending: [], active: [] });
        const url = new URL(path, "http://x");
        queries.push(url.search);
        // like the server: the filter first, then at most 200 rows
        const rows = url.searchParams.get("status") === "waiting" && url.searchParams.get("q") === task ? [...open].slice(0, 200).map((runId) => ({ runId, task })) : [];
        return reply(rows);
      },
      close: async () => undefined,
    };
    await cancelRuns(api, task);
    expect(open.size).toBe(0);
    expect(queries.some((x) => x.includes("status=waiting") && x.includes("q=Many%20waiting"))).toBe(true);
  });

  test("a run whose page never navigated after submit is still cancelled", async ({ browser }) => {
    const task = "Journey clean-up without navigation";
    await withPage(browser, "user", "#/start", async (page, api) => {
      let created: string | undefined;
      try {
        // the server creates the run, but the page never sees the answer
        await page.route((url) => url.pathname === "/api/runs", async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          const response = await route.fetch();
          expect(response.status(), "the start request").toBe(201);
          created = await startedId(response);
          await route.abort();
        });
        await page.locator('textarea[name="task"]').fill(task);
        await page.getByRole("button", { name: "Review", exact: true }).click();
        const failed = page.waitForEvent("requestfailed", isStart);
        await page.getByRole("button", { name: "Start", exact: true }).click();
        await failed;
        expect(page.url()).toMatch(/#\/start$/);
        expect(created, "the run id of the created run").toBeTruthy();
      } finally {
        await cancelRuns(api, task);
      }
      const state = async (): Promise<string> => {
        const res = await api.send("GET", `/api/runs/${created}`);
        if (res.status() === 404) return "gone";
        const body: unknown = await res.json();
        const status = typeof body === "object" && body !== null ? Reflect.get(body, "status") : undefined;
        return typeof status === "string" ? status : "unknown";
      };
      await expect.poll(state, { timeout: 20_000 }).toMatch(/^(cancelled|gone)$/);
    }, { large: true, before: onlyNote });
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
