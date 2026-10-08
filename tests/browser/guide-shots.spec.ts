import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { SHOTS, demoPath, fillPath, splitPath } from "../../scripts/screenshots/shots.js";
import { PREPARE } from "./guide-prepare.js";
import { openAs, openUrl, seed } from "./helpers.js";
import { GUIDE, IMAGES_DIR, ROOT } from "./paths.js";
import { FIXED_NOW, FULL_WIDTH } from "./visual-matrix.js";

declare global {
  interface Window { demoPaths?: (texts: string[]) => Promise<string[]> }
}

/** What /api/providers answers in the guide: the real answer depends on the host's installed agents and local model servers. */
const PROVIDERS = {
  agents: [
    { agent: "claude", installed: true, version: "2.1.0", loggedIn: true, detail: "claude" },
    { agent: "codex", installed: true, version: "0.50.0", loggedIn: true, detail: "codex" },
  ],
  providers: [
    { name: "ollama", kind: "ollama", base_url: "http://localhost:11434", ok: true, detail: "2 models", models: ["qwen3-coder:30b", "gpt-oss:20b"], agents: ["claude", "codex"] },
    { name: "lmstudio", kind: "lmstudio", base_url: "http://localhost:1234", ok: false, detail: "not running", models: [], agents: ["claude", "codex"] },
  ],
};

/** Every text node, title and field value goes through demoPath in one round trip, then the changed ones are written back. */
async function rewrite(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const titled = [...document.querySelectorAll("[title]")];
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")];
    const out = await window.demoPaths!([
      ...texts.map((t) => t.nodeValue ?? ""),
      ...titled.map((e) => e.getAttribute("title") ?? ""),
      ...fields.map((f) => f.value),
    ]);
    let i = 0;
    for (const t of texts) { const v = out[i++]!; if (v !== t.nodeValue) t.nodeValue = v; }
    for (const e of titled) { const v = out[i++]!; if (v !== e.getAttribute("title")) e.setAttribute("title", v); }
    for (const f of fields) { const v = out[i++]!; if (v !== f.value) f.value = v; }
  });
}

/** All text the page holds, hidden text included. */
function leftovers(page: Page): Promise<string> {
  return page.evaluate(() => [
    document.body.textContent ?? "",
    ...[...document.querySelectorAll("[title]")].map((e) => e.getAttribute("title") ?? ""),
    ...[...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].map((f) => f.value),
  ].join("\n"));
}

for (const shot of GUIDE ? SHOTS : []) {
  test(`guide shot: ${shot.name} @guide`, async ({ browser }) => {
    const prep = PREPARE[shot.name] ?? {};
    const s = seed(prep.large ? "large" : "default");
    const big = prep.large ? seed("large").large : undefined;
    const ids: Record<string, string> = { ...s.runs, repoId: s.repoId, sessionId: s.sessionId, watcherId: s.watcherId, ...(big ? { diffRun: big.diffRun } : {}) };
    const { display, hash } = splitPath(fillPath(shot.path, ids));
    const opts = {
      theme: "light" as const, density: "default" as const, fixedNow: FIXED_NOW, large: prep.large,
      before: async (p: Page) => { await p.route("**/api/providers", (r) => r.fulfill({ json: PROVIDERS })); },
    };
    const page = shot.role === "none"
      ? await openUrl(browser, s.url + display + hash, FULL_WIDTH, opts)
      : await openAs(browser, shot.role, FULL_WIDTH, hash, opts);
    try {
      // the admin page sets "system" once it runs (no saved choice); with a light colour scheme that looks light
      await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|system)$/);
      if (shot.path.startsWith("/#/flows/")) {
        // the flow page validates after it renders, and a first render can be replaced before its check ends: reload once if the chip is missing
        const chip = page.locator("#main .status.ok", { hasText: "✓ valid" });
        if (!(await chip.waitFor({ timeout: 5_000 }).then(() => true, () => false))) await page.reload({ waitUntil: "domcontentloaded" });
        await chip.waitFor({ timeout: 15_000 });
      }
      await prep.act?.(page);
      const root = page.locator(shot.role === "none" ? "body" : "#main, #modal-root");
      await expect(root.getByText(shot.expect).filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });
      if (shot.role === "admin") await expect(page.locator("#health-btn")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.exposeFunction("demoPaths", (texts: string[]) => texts.map((t) => demoPath(t, ROOT, homedir())));
      await rewrite(page);
      const clean = async (): Promise<void> => {
        const left = await leftovers(page);
        for (const bad of ["ui-harness-", homedir(), ROOT]) expect(left, `${shot.name} still shows a host path`).not.toContain(bad);
      };
      await clean();
      const png = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
      await clean();
      writeFileSync(join(IMAGES_DIR, `${shot.name}.png`), png);
    } finally {
      await page.context().close();
    }
  });
}
