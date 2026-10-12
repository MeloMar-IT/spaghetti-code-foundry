import { expect, request, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
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
  /** a touch device: `(pointer: coarse)` matches */
  touch?: boolean;
  /** installs the fake clock before navigation; time keeps flowing, `page.clock.fastForward` jumps it */
  clock?: boolean;
  /** runs first on the new page, before the clock and the other setup (for init scripts that must see the page first) */
  before?: (page: Page) => Promise<void>;
}

function newContextFor(browser: Browser, width: number, opts: OpenOptions): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width, height: VIEW_HEIGHT },
    deviceScaleFactor: 1,
    ...(opts.touch ? { hasTouch: true, isMobile: true } : {}),
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

/** The part of a response the helpers read (a Playwright APIResponse fits). */
export interface ApiResponse { status(): number; json(): Promise<unknown> }

export interface Api { send(method: string, path: string, body?: unknown): Promise<ApiResponse>; close(): Promise<void> }

/** Calls the server's API as `role` (on the large server with `which: "large"`), for set-up and clean-up of a test (the CSRF token goes with every method other than GET and HEAD). */
export async function apiAs(role: Role, which: "default" | "large" = "default"): Promise<Api> {
  const s = seed(which);
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

/** Starts a run through the API and waits until it has `status`; returns its id. */
export async function startRun(api: Api, flow: string, task: string, status: string): Promise<string> {
  const res = await api.send("POST", "/api/runs", { flow, task });
  expect(res.status(), `start the ${flow} run`).toBe(201);
  const { runId } = (await res.json()) as { runId: string };
  await expect.poll(async () => ((await (await api.send("GET", `/api/runs/${runId}`)).json()) as { status: string }).status, { timeout: 20_000 }).toBe(status);
  return runId;
}

/** The `task` of each entry of `rows` that has one, with its id (`key` names the id field). */
function idsWithTask(rows: unknown, key: string, task: string): string[] {
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const id: unknown = Reflect.get(row, key);
    if (Reflect.get(row, "task") === task && typeof id === "string") ids.push(id);
  }
  return ids;
}

async function readJson(api: Api, path: string): Promise<unknown> {
  const res = await api.send("GET", path);
  if (res.status() !== 200) throw new Error(`GET ${path} answered ${res.status()}`);
  return res.json();
}

/**
 * Cancels every running or waiting run and every queued job with this task (a queued job has no run record yet).
 * The queue is read first, so a job that starts in between is found in the run lists. The run lists are cut to 200 rows, so they are
 * filtered by the task before the cap (`q`, a substring match; skipped for a task over 200 characters) and read again until no run
 * with the task is left. Every id is tried, also after a failure or a rejected request; the failures are reported at the end.
 */
export async function cancelRuns(api: Api, task: string): Promise<void> {
  const queue = await readJson(api, "/api/queue");
  const pending = typeof queue === "object" && queue !== null ? Reflect.get(queue, "pending") : undefined;
  const failed: string[] = [];
  const tried = new Set<string>();
  const cancel = async (id: string): Promise<void> => {
    tried.add(id);
    try {
      const res = await api.send("POST", `/api/runs/${id}/cancel`, {});
      if (res.status() >= 300) failed.push(`${id} (${res.status()})`);
    } catch (e) {
      failed.push(`${id} (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  for (const id of idsWithTask(pending, "runId", task)) await cancel(id);
  const q = [...task].length <= 200 ? `&q=${encodeURIComponent(task)}` : "";
  for (const status of ["running", "waiting"]) {
    for (;;) {
      const fresh = idsWithTask(await readJson(api, `/api/runs?status=${status}${q}`), "runId", task).filter((id) => !tried.has(id));
      if (!fresh.length) break;
      for (const id of fresh) await cancel(id);
    }
  }
  if (failed.length) throw new Error(`could not cancel: ${failed.join(", ")}`);
}

/** The elements whose right edge is past the viewport (tag, id, classes), deepest first, at most 10. */
export async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const view = document.documentElement.clientWidth;
    const depth = (e: Element): number => (e.parentElement ? 1 + depth(e.parentElement) : 0);
    return [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > view + 0.5 && e.getClientRects().length > 0)
      .sort((a, b) => depth(b) - depth(a))
      .slice(0, 10)
      .map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""}`);
  });
}

/** Fails when the document is wider than the viewport. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { doc, body, view } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  const wide = Math.max(doc, body) > view ? await overflowing(page) : [];
  expect(Math.max(doc, body), `the document is ${Math.max(doc, body)} px wide in a ${view} px viewport; past the edge: ${wide.join(", ")}`).toBeLessThanOrEqual(view);
}

/** Runs in the page (Playwright sends its source, so it uses nothing from this file): the work of clipped, expectReadable and lengthen. */
function inPage(els: Element[], q: { op: "clipped" | "readable" | "lengthen"; strict: boolean }): string[] {
  const name = (e: Element): string => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""}`;
  const rectsOf = (n: Text): DOMRect[] => {
    const r = document.createRange();
    r.selectNodeContents(n);
    return [...r.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
  };
  // can the rect [lo, hi] be moved by some d in [d0, d1] so that it lies inside [min, max] (with a tolerance)?
  const fits = (lo: number, hi: number, min: number, max: number, tol: number, d0: number, d1: number): boolean =>
    Math.max(d0, min - tol - lo) <= Math.min(d1, max + tol - hi);
  const look = (n: Text): "hidden" | "cut" | "ellipsis" | "ok" => {
    const rects = rectsOf(n);
    if (!rects.length || !n.parentElement || getComputedStyle(n.parentElement).visibility !== "visible") return "hidden";
    let dx0 = 0, dx1 = 0, dy0 = 0, dy1 = 0, skip = "";
    let found: "cut" | "ellipsis" | "ok" = "ok";
    for (let a: Element | null = n.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      // these also make the containing block of fixed and absolute descendants
      const makesBlock = s.transform !== "none" || s.perspective !== "none" || s.filter !== "none" || /transform|perspective|filter/.test(s.willChange) || /paint|layout|strict|content/.test(s.contain);
      if (!makesBlock && (skip === "fixed" || (skip === "absolute" && s.position === "static"))) continue;
      skip = s.position === "fixed" || s.position === "absolute" ? s.position : "";
      if (s.display === "inline" || s.display === "contents") continue;
      const clipX = /hidden|clip/.test(s.overflowX), clipY = /hidden|clip/.test(s.overflowY);
      if ((clipX || clipY) && (a.clientWidth <= 1 || a.clientHeight <= 1)) return "hidden";
      const o = a.getBoundingClientRect(), left = o.left + a.clientLeft, top = o.top + a.clientTop;
      const ellipsis = s.textOverflow === "ellipsis";
      const cutX = clipX && (rects.some((b) => !fits(b.left, b.right, left, left + a.clientWidth, 1, dx0, dx1)) || (ellipsis && a.scrollWidth > a.clientWidth + 1));
      const cutY = clipY && rects.some((b) => !fits(b.top, b.bottom, top, top + a.clientHeight, b.height / 4, dy0, dy1));
      if (cutY || (cutX && !ellipsis)) found = "cut";
      else if (cutX && found === "ok") found = "ellipsis";
      // inside a scroll container the text can move; outer clipping is judged against what that allows
      if (/auto|scroll/.test(s.overflowX)) { dx0 -= a.scrollWidth - a.clientWidth - a.scrollLeft; dx1 += a.scrollLeft; }
      if (/auto|scroll/.test(s.overflowY)) { dy0 -= a.scrollHeight - a.clientHeight - a.scrollTop; dy1 += a.scrollTop; }
    }
    return found;
  };
  const texts = (root: Element): Text[] => {
    const out: Text[] = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n instanceof Text && n.data.trim() !== "" && look(n) !== "hidden") out.push(n);
    return out;
  };
  const cutNames = (roots: Element[], strict: boolean): string[] => {
    const nodes = new Set<Text>(roots.flatMap(texts));
    const owners = new Set<Element>();
    for (const n of nodes) {
      const l = look(n);
      if ((l === "cut" || (strict && l === "ellipsis")) && n.parentElement) owners.add(n.parentElement);
    }
    return [...owners].map(name);
  };

  if (q.op === "clipped") return cutNames(els, q.strict);

  if (q.op === "lengthen") {
    const nodes = new Set<Text>(els.flatMap(texts));
    const names: string[] = [];
    for (const n of nodes) {
      const d = n.data, t = d.trim(), end = d.trimEnd().length;
      n.data = d.slice(0, end) + " " + t.slice(0, Math.ceil(t.length * 0.4)) + d.slice(end);
      if (n.parentElement) { n.parentElement.setAttribute("data-lengthened", ""); names.push(name(n.parentElement)); }
    }
    return names;
  }

  const el = els[0];
  if (els.length !== 1 || !el) return [`the target matches ${els.length} elements; expected exactly one`];
  const problems: string[] = [];
  const cut = cutNames([el], true);
  if (cut.length) problems.push(`text is cut off in ${cut.join(", ")}`);
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const width = el.getBoundingClientRect().width;
  if (width > vw + 0.5) problems.push(`${name(el)} is ${Math.round(width)} px wide in a ${vw} px viewport`);

  const last = texts(el).pop();
  let owner: Element = el;
  let box = (): DOMRect => el.getBoundingClientRect();
  if (last && last.parentElement) {
    const p = last.parentElement;
    owner = p;
    box = () => rectsOf(last).pop() ?? p.getBoundingClientRect();
  } else {
    const o = [el, ...el.querySelectorAll("*")].filter((e) => e.getClientRects().length > 0).pop() ?? el;
    owner = o;
    box = () => o.getBoundingClientRect();
  }
  const accepts = (hit: Element | null): boolean => {
    if (!hit) return false;
    if (hit === owner) return true;
    if (getComputedStyle(owner).display !== "contents") return false;
    let a = owner.parentElement;
    while (a && getComputedStyle(a).display === "contents") a = a.parentElement;
    return hit === a;
  };

  const saved: [Element, number, number][] = [];
  for (let a: Element | null = owner; a; a = a.parentElement) saved.push([a, a.scrollLeft, a.scrollTop]);
  const x0 = window.scrollX, y0 = window.scrollY;
  let first = "";
  let reachable = false;
  try {
    for (const mode of ["centre", "end", "start"] as const) {
      const place = (b: DOMRect, min: number, max: number): number =>
        mode === "centre" ? (b.top + b.bottom) / 2 - (min + max) / 2 : mode === "end" ? b.bottom - max : b.top - min;
      // the body scrolls on its own only when the root element does not take its overflow
      const rs = getComputedStyle(document.documentElement);
      const bodyScrolls = rs.overflowX !== "visible" || rs.overflowY !== "visible";
      for (let a: Element | null = owner; a && a !== document.documentElement && (a !== document.body || bodyScrolls); a = a.parentElement) {
        const s = getComputedStyle(a);
        if (!/auto|scroll/.test(s.overflowX + s.overflowY)) continue;
        const b = box(), c = a.getBoundingClientRect();
        const cl = c.left + a.clientLeft, ct = c.top + a.clientTop;
        a.scrollBy({ left: (b.left + b.right) / 2 - (cl + a.clientWidth / 2), top: place(b, ct, ct + a.clientHeight), behavior: "instant" });
      }
      window.scrollBy({ left: 0, top: place(box(), 0, vh), behavior: "instant" });
      const b = box(), cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      let problem = "";
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) problem = `the last content of ${name(el)} cannot be scrolled into view`;
      else {
        const hit = document.elementFromPoint(cx, cy);
        if (!accepts(hit)) problem = `the last content of ${name(el)} is covered by ${hit ? name(hit) : "nothing"}`;
      }
      if (!problem) { reachable = true; break; }
      first ||= problem;
    }
  } finally {
    for (const [e, left, top] of saved) e.scrollTo({ left, top, behavior: "instant" });
    window.scrollTo({ left: x0, top: y0, behavior: "instant" });
  }
  if (!reachable && first) problems.push(first);
  return problems;
}

/** Fails when the control is not visible, enabled, inside the viewport and uncovered at its centre (and, with `touch`, at least 44 × 44 px). */
export async function expectUsable(page: Page, target: Locator, opts: { touch?: boolean } = {}): Promise<void> {
  await expect(target, "the control is visible").toBeVisible();
  await expect(target, "the control is enabled").toBeEnabled();
  const problems = await target.evaluate((el, touch) => {
    const name = (e: Element): string => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""}`;
    const out: string[] = [];
    const x0 = window.scrollX;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (window.scrollX !== x0) window.scrollTo({ left: x0, top: window.scrollY, behavior: "instant" });
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
      out.push(`${name(el)} is outside the viewport (${Math.round(r.left)}, ${Math.round(r.top)} in ${vw} × ${vh})`);
    } else {
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !el.contains(hit)) out.push(`${name(el)} is covered by ${hit ? name(hit) : "nothing"} at its centre`);
    }
    if (touch && (r.width < 43.5 || r.height < 43.5)) out.push(`${name(el)} is ${Math.round(r.width)} × ${Math.round(r.height)} px; a touch target needs 44 × 44 px`);
    return out;
  }, opts.touch ?? false);
  expect(problems, problems.join("; ")).toEqual([]);
}

/** Fails when the content is wider than the viewport, has cut-off text (ellipsis too), or its last content cannot be scrolled into view uncovered; scroll positions are put back. */
export async function expectReadable(page: Page, target: Locator): Promise<void> {
  await expect(target, "the content is visible").toBeVisible();
  const problems = await target.evaluateAll(inPage, { op: "readable" as const, strict: true });
  expect(problems, problems.join("; ")).toEqual([]);
}

/** The elements (tag, id, classes) that own text cut off by a clipping ancestor; `strict` also counts text-overflow: ellipsis. */
export async function clipped(page: Page, scope: string | Locator, opts: { strict?: boolean } = {}): Promise<string[]> {
  const roots = typeof scope === "string" ? page.locator(scope) : scope;
  return roots.evaluateAll(inPage, { op: "clipped" as const, strict: opts.strict ?? false });
}

/** Makes the visible text under `scope` 1.4 times as long, marks its elements with data-lengthened, and returns how many text nodes it changed. */
export async function lengthen(page: Page, scope: string): Promise<number> {
  return (await page.locator(scope).evaluateAll(inPage, { op: "lengthen" as const, strict: false })).length;
}

/** The primary links and actions of a role, from ui/ia.js. */
export async function navFor(role: Role): Promise<{ primary: NavItem[]; actions: NavItem[] }> {
  const ia = await import("../../ui/ia.js" as string);
  return { primary: ia.primaryFor(role), actions: ia.actionsFor(role) };
}
