import { expect, type Browser, type Page } from "@playwright/test";
import type { SeedData } from "./seed.js";
import { VIEW_HEIGHT } from "./widths.js";

export type Role = "admin" | "user";
export type Seed = SeedData;

export interface NavItem { id: string; label: string; href: string }

/** What the launcher seeded (read from UI_TEST_SEED; throws a plain error when it is missing). */
export function seed(): Seed {
  const raw = process.env.UI_TEST_SEED;
  if (!raw) throw new Error("UI_TEST_SEED is not set: run the browser tests with `npm run test:ui`");
  return JSON.parse(raw) as Seed;
}

/** "/" for an admin, "/user/" for a user. */
export const displayPath = (role: Role): string => (role === "admin" ? "/" : "/user/");

/** A new browser context at `width`, signed in as `role`, on its display (optionally at `hash`). The caller closes `page.context()`. */
export async function openAs(browser: Browser, role: Role, width: number, hash = ""): Promise<Page> {
  const s = seed();
  const who = s[role];
  const context = await browser.newContext({ viewport: { width, height: VIEW_HEIGHT } });
  try {
    const res = await context.request.post(s.url + "/api/session", { data: { email: who.email, password: who.password } });
    expect(res.status(), "sign-in").toBe(200);
    const page = await context.newPage();
    // never "networkidle": the pages keep an event stream open
    await page.goto(s.url + displayPath(role) + hash, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).not.toHaveClass(/signed-out/);
    await expect(page.locator("#main")).toHaveAttribute("aria-label", /.+/);
    return page;
  } catch (e) {
    await context.close();
    throw e;
  }
}

/** Fails when the document is wider than the viewport. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { doc, body, view } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(Math.max(doc, body), `the document is ${Math.max(doc, body)} px wide in a ${view} px viewport`).toBeLessThanOrEqual(view);
}

/** The primary links and actions of a role, from ui/ia.js. */
export async function navFor(role: Role): Promise<{ primary: NavItem[]; actions: NavItem[] }> {
  const ia = await import("../../ui/ia.js" as string);
  return { primary: ia.primaryFor(role), actions: ia.actionsFor(role) };
}
