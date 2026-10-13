import { expect, test, type Browser, type Locator, type Page, type Response } from "@playwright/test";
import {
  apiAs, boardJson, card, cancelRuns, displayPath, expectBoardFits, expectNoSidewaysScroll, expectReadable, expectUsable, isStart, onlyNote, openAs,
  openUrl, seed, startedId, startRun, type Role,
} from "./helpers.js";
import { ESSENTIAL, usesDrawer, VARIANTS, type EssentialName, type Variant } from "./widths.js";

// The eight essential journeys at 360 and 768 px (touch) and at 1024 and 1440 px. Each step proves the control with
// expectUsable, acts, then proves the arrival: the expected state, expectReadable on the content, no sideways scroll.
// The results are copied to "## Responsive results" in docs/ui-redesign/measurement.md.

const use = (page: Page, v: Variant, control: Locator) => expectUsable(page, control, { touch: v.touch });

async function arrived(page: Page, content: Locator): Promise<void> {
  // a page that draws again (the run page, on every event) can replace the element between the two reads: look again
  await expect(async () => { await expectReadable(page, content); }).toPass({ timeout: 10_000 });
  await expectNoSidewaysScroll(page);
}

/** The text that proves a page has drawn its data: exactly one element. */
const text = (page: Page, t: string | RegExp): Locator => page.locator("#main").getByText(t).first();

/** Opens a page of the navigation (through the menu button where the navigation is in the drawer). */
async function goNav(page: Page, v: Variant, id: string): Promise<void> {
  if (usesDrawer(v.width)) {
    await use(page, v, page.locator("#menu-btn"));
    await page.locator("#menu-btn").click();
    await expect(page.locator("body")).toHaveClass(/drawer-open/);
  }
  const link = page.locator(`#side a[data-nav="${id}"]`);
  await use(page, v, link);
  await link.click();
  await expect(link).toHaveAttribute("aria-current", /page|true/);
  if (usesDrawer(v.width)) await expect(page.locator("body")).not.toHaveClass(/drawer-open/);
}

const HOME_READY: Record<Role, string> = { admin: "Seeded gate run", user: "Seeded failed run" };

async function signIn(browser: Browser, v: Variant, role: Role): Promise<void> {
  const s = seed();
  const page = await openUrl(browser, s.url + displayPath(role), v.width, { touch: v.touch });
  try {
    await expect(page.locator("body")).toHaveClass(/signed-out/);
    const email = page.locator('form.auth-card input[name="email"]');
    const password = page.locator('form.auth-card input[name="password"]');
    const submit = page.locator("form.auth-card").getByRole("button", { name: "Sign in" });
    await use(page, v, email);
    await email.fill(s[role].email);
    await use(page, v, password);
    await password.fill(s[role].password);
    await use(page, v, submit);
    await submit.click();
    await expect(page.locator("body")).not.toHaveClass(/signed-out/);
    await expect(page.locator("#main")).toHaveAttribute("aria-label", /.+/);
    await expect(page.locator("#main")).toContainText(HOME_READY[role]);
    await arrived(page, page.locator("#main h1").first());
  } finally {
    await page.context().close();
  }
}

const JOURNEYS: Record<EssentialName, (browser: Browser, v: Variant) => Promise<void>> = {
  "Sign in": async (browser, v) => {
    await signIn(browser, v, "user");
    await signIn(browser, v, "admin");
  },

  "Find what needs me": async (browser, v) => {
    test.setTimeout(120_000);
    const TASK = "Essential needs me " + v.label;
    const api = await apiAs("admin", "large");
    let page: Page | undefined;
    try {
      const runId = await startRun(api, "gate", TASK, "waiting");
      page = await openAs(browser, "admin", v.width, "", { large: true, touch: v.touch });
      const open = page.locator(".turn-item", { hasText: TASK }).locator('a[data-focus^="turn-open-"]');
      await use(page, v, open);
      await open.click();
      await expect(page).toHaveURL(new RegExp(`#/runs/${runId}$`));
      await expect(page.locator('[data-focus="act-approve"]')).toBeVisible();
      await arrived(page, text(page, TASK));

      const approve = page.locator('[data-focus="act-approve"]');
      await use(page, v, approve);
      await approve.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await arrived(page, dialog.getByRole("heading").first());

      const submit = dialog.getByRole("button", { name: "Approve", exact: true });
      await use(page, v, submit);
      await submit.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator("#toast")).toContainText("Approved — continuing");
      await expect.poll(async () => ((await (await api.send("GET", `/api/runs/${runId}`)).json()) as { status: string }).status, { timeout: 20_000 }).not.toBe("waiting");
      await arrived(page, text(page, TASK));
    } finally {
      await page?.context().close();
      try { await cancelRuns(api, TASK); } finally { await api.close(); }
    }
  },

  "Start work": async (browser, v) => {
    test.setTimeout(120_000);
    const TASK = "Essential start work " + v.label;
    const api = await apiAs("user", "large");
    let page: Page | undefined;
    let posted: Promise<string | undefined> = Promise.resolve(undefined);
    try {
      page = await openAs(browser, "user", v.width, "", { large: true, touch: v.touch, before: onlyNote });
      page.on("response", (r) => { if (isStart(r.request())) posted = startedId(r); });
      const start = page.locator('#top-actions a[data-nav="start"]');
      await use(page, v, start);
      await start.click();
      await expect(page).toHaveURL(/#\/start$/);

      const task = page.locator('textarea[name="task"]');
      await expect(task).toBeVisible();
      await arrived(page, page.locator("#main h1").first());
      await use(page, v, task);
      await task.fill(TASK);
      const review = page.locator('[data-focus="start-review"]');
      await use(page, v, review);
      await review.click();
      const go = page.locator('[data-focus="start-run"]');
      await expect(go).toBeVisible();
      await arrived(page, text(page, TASK));

      await use(page, v, go);
      await go.click();
      await expect(page).toHaveURL(/#\/runs\/[\w-]+$/);
      await arrived(page, text(page, TASK));
      const runUrl = page.url();

      await goNav(page, v, "runs");
      const link = page.locator("li.run-card", { hasText: TASK }).locator("a.run-link");
      await expect(link).toBeVisible();
      await arrived(page, link);
      await use(page, v, link);
      await link.click();
      await expect(page).toHaveURL(runUrl);
      await arrived(page, text(page, TASK));

      const logTab = page.locator('button[data-tab="log"]');
      await use(page, v, logTab);
      await logTab.click();
      await expect(page.locator("#main pre.log")).toContainText("NOTE_WAITING");
      await arrived(page, page.locator("#main pre.log"));

      const diffTab = page.locator('button[data-tab="diff"]');
      await use(page, v, diffTab);
      await diffTab.click();
      const diff = page.locator("#main pre.diff").first();
      await expect(diff).toContainText("+" + TASK);
      await arrived(page, diff);
    } finally {
      await page?.context().close();
      try {
        const id = await posted;
        if (id) await api.send("POST", `/api/runs/${id}/cancel`, {}).catch(() => undefined);
        await cancelRuns(api, TASK);
      } finally {
        await api.close();
      }
    }
  },

  "Diagnose a failed run": async (browser, v) => {
    const s = seed();
    const page = await openAs(browser, "admin", v.width, "", { touch: v.touch });
    try {
      await goNav(page, v, "runs");
      const link = page.locator(`a.run-link[data-focus="open-${s.runs.failed}"]`);
      // the id picks the run: the user's seeded failed run has the same task text
      await expect(link).toBeVisible();
      await arrived(page, link);
      await expect(page.locator("li.run-card").filter({ has: link })).toContainText("Seeded failed run");
      await use(page, v, link);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#/runs/${s.runs.failed}$`));
      const failure = page.locator(".card.next-step.failure");
      await expect(failure).toContainText("This run failed");
      // the head of the card: the closed "Raw details" text below it still has a box, which expectReadable would judge
      await arrived(page, failure.locator(".next-parts").first());

      const step = page.locator('[data-focus="failed-step"]');
      if ((await step.count()) > 0) {
        await use(page, v, step);
        await step.click();
        const open = page.locator("details.tl[open]").first();
        await expect(open).toBeVisible();
        await arrived(page, open.locator("summary").first());
      }
    } finally {
      await page.context().close();
    }
  },

  "Board": async (browser, v) => {
    const cards = [card(5, "Five", "coding"), card(6, "Six", "done"), card(7, "Reviewing story", "reviewing")];
    const page = await openAs(browser, "admin", v.width, "", {
      touch: v.touch,
      before: async (p) => { await p.route("**/api/board", (r) => r.fulfill({ json: boardJson(cards) })); },
    });
    try {
      await goNav(page, v, "board");
      await expect(text(page, "Five")).toBeVisible();
      const reviewing = page.locator("#main .board-col.reviewing");
      if (usesDrawer(v.width)) {
        const pick = page.locator("#main .board-pick select");
        await use(page, v, pick);
        await pick.selectOption("reviewing");
        await expect(reviewing).toBeVisible();
        await expectBoardFits(page);
      } else {
        await expect(page.locator("#main .board-pick")).toBeHidden();
      }
      await expect(reviewing).toContainText("#7");
      await arrived(page, reviewing.locator(".board-card"));
    } finally {
      await page.context().close();
    }
  },

  "Refine": async (browser, v) => {
    const s = seed();
    const page = await openAs(browser, "user", v.width, "", { touch: v.touch });
    try {
      await goNav(page, v, "refinement");
      const session = page.locator(`#main a[href="#/refinement/${s.sessionId}"]`);
      await expect(session).toBeVisible();
      await arrived(page, session);
      await use(page, v, session);
      await session.click();
      await expect(page).toHaveURL(new RegExp(`#/refinement/${s.sessionId}$`));
      await arrived(page, text(page, "Show the build status on the board"));
      const drafts = page.getByRole("tab", { name: /^Story drafts/ });
      await use(page, v, drafts);
      await drafts.click();
      // New draft is only proven, not clicked: it would change the seeded session that visual.spec.ts captures
      const newDraft = page.getByRole("button", { name: "New draft" });
      await use(page, v, newDraft);
      await arrived(page, newDraft);
    } finally {
      await page.context().close();
    }
  },

  "Repositories": async (browser, v) => {
    const api = await apiAs("user");
    const page = await openAs(browser, "user", v.width, "", { touch: v.touch });
    try {
      const before = await (await api.send("GET", "/api/repos")).json();
      await goNav(page, v, "repos");
      await arrived(page, text(page, "acme/app"));

      const add = page.locator('[data-focus="add-toolbar"]');
      await use(page, v, add);
      await add.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await arrived(page, dialog.getByRole("heading").first());

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(add).toBeFocused();
      await expect(text(page, "acme/app")).toBeVisible();
      await expectNoSidewaysScroll(page);
      expect(await (await api.send("GET", "/api/repos")).json(), "nothing was added").toEqual(before);
    } finally {
      await page.context().close();
      await api.close();
    }
  },

  "Sign out": async (browser, v) => {
    const page = await openAs(browser, "user", v.width, "", { touch: v.touch });
    try {
      const summary = page.locator("#account-summary");
      await use(page, v, summary);
      await summary.click();
      await expect(page.locator("#account")).toHaveJSProperty("open", true);
      const out = page.locator("#user").getByRole("button", { name: "Sign out" });
      await expectNoSidewaysScroll(page);
      await use(page, v, out);
      await out.click();
      await expect(page.locator("body")).toHaveClass(/signed-out/);
      const email = page.locator('form.auth-card input[name="email"]');
      await use(page, v, email);
      await use(page, v, page.locator('form.auth-card input[name="password"]'));
      await use(page, v, page.locator("form.auth-card").getByRole("button", { name: "Sign in" }));
      await arrived(page, page.locator("form.auth-card h2"));
    } finally {
      await page.context().close();
    }
  },
};

ESSENTIAL.forEach((name, i) => {
  for (const v of VARIANTS) {
    test(`${i + 1} ${name} at ${v.label}`, async ({ browser }) => {
      await JOURNEYS[name](browser, v);
    });
  }
});

// Not run as a drawer test: Ask SCF is switched off on the seeded servers (help.enabled is not set), so there is no drawer
// to open. The guard below proves it is off; the drawer itself waits for the follow-up named in the annotation.
test("Ask SCF drawer at every width", () => {
  test.info().annotations.push({
    type: "follow-up",
    description: 'follow-up "UI quality 1f follow-up — Ask SCF drawer at the four widths with help switched on"',
  });
});

for (const role of ["admin", "user"] as const) {
  test(`Ask SCF is off: #ask-scf is hidden and empty on the ${role} display`, async ({ browser }) => {
    let waited: Promise<Response> | undefined;
    const page = await openAs(browser, role, 1440, "", {
      before: async (p) => { waited = p.waitForResponse((r) => new URL(r.url()).pathname === "/api/help/conversations"); },
    });
    try {
      const res = await waited;
      expect(res?.status(), "the help answer").toBe(200);
      const info: unknown = await res?.json();
      expect(typeof info === "object" && info !== null ? Reflect.get(info, "enabled") : undefined, "the help answer says it is switched off").toBe(false);
      await expect(page.locator("#ask-scf")).toBeHidden();
      await expect(page.locator("#ask-scf")).toBeEmpty();
    } finally {
      await page.context().close();
    }
  });
}
