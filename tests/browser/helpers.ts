import { expect, request, type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { SeedData } from "./seed.js";
import type { Density, Theme } from "./visual-matrix.js";
import { VIEW_HEIGHT } from "./widths.js";

export type Role = "admin" | "user";
export type Seed = SeedData;

export interface NavItem { id: string; label: string; href: string }

/** What the launcher seeded (read from UI_TEST_SEED, or UI_TEST_SEED_LARGE for "large"; throws a plain error when it is missing). */
export function seed(which: "default" | "large" = "default"): Seed {
  const name = which === "large" ? "UI_TEST_SEED_LARGE" : "UI_TEST_SEED";
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set: run the browser tests with \`npm run test:ui\``);
  return JSON.parse(raw) as Seed;
}

/** "/" for an admin, "/user/" for a user. */
export const displayPath = (role: Role): string => (role === "admin" ? "/" : "/user/");

export interface OpenOptions {
  /** sets data-theme on <html> before the page scripts run */
  theme?: Theme;
  /** "compact" sets data-density on <html>; "default" sets nothing */
  density?: Density;
  /** ISO time: the page clock is fixed to it before navigation */
  fixedNow?: string;
  /** `openAs` signs in to the large server (UI_TEST_SEED_LARGE) */
  large?: boolean;
  /** installs the fake clock before navigation; time keeps flowing, `page.clock.fastForward` jumps it */
  clock?: boolean;
  /** runs first on the new page, before the clock and the other setup (for init scripts that must see the page first) */
  before?: (page: Page) => Promise<void>;
}

function newContextFor(browser: Browser, width: number, opts: OpenOptions): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width, height: VIEW_HEIGHT },
    deviceScaleFactor: 1,
    ...(opts.theme ? { colorScheme: opts.theme, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" as const } : {}),
  });
}

async function prepare(page: Page, opts: OpenOptions): Promise<void> {
  if (opts.before) await opts.before(page);
  if (opts.clock) await page.clock.install();
  if (opts.fixedNow) await page.clock.setFixedTime(new Date(opts.fixedNow));
  if (!opts.theme) return;
  await page.addInitScript(({ theme, density }) => {
    const apply = (): boolean => {
      const el = document.documentElement;
      if (!el) return false;
      el.setAttribute("data-theme", theme);
      if (density === "compact") el.setAttribute("data-density", "compact");
      return true;
    };
    if (apply()) return;
    // in Chromium <html> may not exist yet when init scripts run
    const mo = new MutationObserver(() => { if (apply()) mo.disconnect(); });
    mo.observe(document, { childList: true });
  }, { theme: opts.theme, density: opts.density ?? "default" });
}

/** A new context at `width` on `url`, no sign-in (the gallery file, the sign-in page). The caller closes `page.context()`. */
export async function openUrl(browser: Browser, url: string, width: number, opts: OpenOptions = {}): Promise<Page> {
  const context = await newContextFor(browser, width, opts);
  try {
    const page = await context.newPage();
    await prepare(page, opts);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  } catch (e) {
    await context.close();
    throw e;
  }
}

/** A new browser context at `width`, signed in as `role`, on its display (optionally at `hash`). The caller closes `page.context()`. */
export async function openAs(browser: Browser, role: Role, width: number, hash = "", opts: OpenOptions = {}): Promise<Page> {
  const s = seed(opts.large ? "large" : "default");
  const who = s[role];
  const context = await newContextFor(browser, width, opts);
  try {
    const res = await context.request.post(s.url + "/api/session", { data: { email: who.email, password: who.password } });
    expect(res.status(), "sign-in").toBe(200);
    const page = await context.newPage();
    await prepare(page, opts);
    // never "networkidle": the pages keep an event stream open
    await page.goto(s.url + displayPath(role) + hash, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).not.toHaveClass(/signed-out/);
    // the large data can keep the page busy for seconds (that is what the performance spec measures)
    await expect(page.locator("#main")).toHaveAttribute("aria-label", /.+/, { timeout: opts.large ? 30_000 : 5_000 });
    return page;
  } catch (e) {
    await context.close();
    throw e;
  }
}

export interface Api { send(method: string, path: string, body?: unknown): Promise<APIResponse>; close(): Promise<void> }

/** Calls the server's API as `role`, for set-up and clean-up of a test (the CSRF token goes with every method other than GET and HEAD). */
export async function apiAs(role: Role): Promise<Api> {
  const s = seed();
  const who = s[role];
  const ctx = await request.newContext({ baseURL: s.url });
  const res = await ctx.post("/api/session", { data: { email: who.email, password: who.password } });
  expect(res.status(), "sign-in").toBe(200);
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return {
    send: (method, path, body) =>
      ctx.fetch(path, { method, headers: method === "GET" || method === "HEAD" ? {} : { "x-csrf-token": csrfToken }, ...(body === undefined ? {} : { data: body }) }),
    close: () => ctx.dispose(),
  };
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
