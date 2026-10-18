import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, expectReadable, expectUsable, openAs, seed, type Role } from "./helpers.js";

// The Evidence record section of the run page at 360 px: long values wrap, the buttons work with the keyboard, the
// administrator's file list opens, and Export evidence saves the answer of the API as evidence-<run id>.json.
// The evidence answer is served by the test, with long values; the seeded runs have no evidence of their own.

const SHA = "a".repeat(64);
const LONG = "very-long-name-".repeat(8);
const FILES = [
  { kind: "transcript", path: `logs/${LONG}.log`, sha256: SHA, bytes: 3, required: true, state: "ok" },
  { kind: "diff", path: "evidence.diff", sha256: SHA, bytes: 3, required: false, state: "changed" },
];
const answer = (runId: string, admin: boolean) => ({
  runId, state: "available",
  verification: { status: "failed", verified: false, explanation: "x", checks: [], missingOptional: [], failure: { check: "files", code: "file-changed", message: `logs/${LONG}.log changed`, path: `logs/${LONG}.log` } },
  manifest: {
    version: 1, runId, status: "succeeded", startedAt: "2026-01-01T10:00:00Z", finishedAt: "2026-01-01T11:00:00Z",
    flow: { name: LONG, version: 3, sha256: SHA },
    git: { repository: `acme/${LONG}`, branch: `feature/${LONG}`, base: "1234567890abcdef", final: "fedcba0987654321" },
    ...(admin ? { models: [{ agent: "claude", provider: "anthropic", model: LONG }], policies: [{ id: LONG, version: "1.0" }] } : {}),
    approvals: [], tests: [], artifacts: FILES, pullRequest: { repository: `acme/${LONG}`, number: 7, url: "https://github.com/acme/app/pull/7" },
  },
  artifacts: FILES,
});

async function openEvidence(page: Page, runId: string, admin: boolean): Promise<void> {
  await page.route(/\/api\/runs\/[^/]+\/evidence$/, (route) => route.fulfill({ json: answer(runId, admin) }));
  await page.goto(page.url().replace(/#.*$/, "") + `#/runs/${runId}`, { waitUntil: "domcontentloaded" });
  await page.locator('button[data-tab="evidence"]').click();
  await expect(page.locator("#main").getByRole("heading", { name: "Evidence record" })).toBeVisible();
}

for (const role of ["admin", "user"] as Role[]) {
  test(`the evidence record works at 360 px as ${role}`, async ({ browser }) => {
    const admin = role === "admin";
    const s = seed();
    const runId = role === "admin" ? s.runs.succeeded! : s.userRuns[0]!;
    const page = await openAs(browser, role, 360, "", { touch: true });
    try {
      await openEvidence(page, runId, admin);
      const status = page.locator('#main [role="status"]', { hasText: "Not verified" });
      await expect(status).toBeVisible();
      await expect(page.locator("#main")).toContainText("Verification failed");
      await expect(page.locator("#main")).toContainText("What to do:");
      await expectReadable(page, page.locator("#main section[aria-labelledby]"));
      await expectNoSidewaysScroll(page);

      const files = page.locator("#main details");
      if (role === "admin") {
        await expect(files).toHaveCount(1);
        await files.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect(files).toHaveAttribute("open", "");
        await expect(files.locator("li")).toHaveCount(2);
        await expectNoSidewaysScroll(page);
      } else {
        await expect(files).toHaveCount(0);
        await expect(page.locator("#main")).not.toContainText("logs/");
        await expect(page.locator("#main")).not.toContainText("evidence.diff");
      }

      const check = page.locator('[data-focus="evidence-refresh"]');
      const exportBtn = page.locator('[data-focus="evidence-export"]');
      await expectUsable(page, check, { touch: true });
      await expectUsable(page, exportBtn, { touch: true });
      await check.focus();
      await page.keyboard.press("Tab");
      await expect(exportBtn).toBeFocused();

      const download = page.waitForEvent("download");
      await page.keyboard.press("Enter");
      const d = await download;
      expect(d.suggestedFilename()).toBe(`evidence-${runId}.json`);
      const path = await d.path();
      const { readFileSync } = await import("node:fs");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(answer(runId, admin));
    } finally {
      await page.context().close();
    }
  });
}
