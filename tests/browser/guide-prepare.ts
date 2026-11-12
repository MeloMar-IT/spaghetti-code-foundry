import type { Page } from "@playwright/test";

/** `before` runs on the new page before it opens (routes); `act` after it is open. */
export interface ShotPrep { large?: boolean; before?: (page: Page) => Promise<void>; act?: (page: Page) => Promise<void> }

/** The look names of the "looks" shot, in the order of the picker. */
const LOOKS = [["calm", "Calm"], ["midnight", "Midnight"], ["friendly", "Friendly"], ["editorial", "Editorial"], ["bento", "Bento"]] as const;

/** Per-shot steps that run after the page is open. */
export const PREPARE: Record<string, ShotPrep> = {
  "flow-yaml": {
    // the click re-renders the flow page with a new, empty status chip; the chip is checked after it
    act: async (page) => {
      await page.locator("#main .seg button", { hasText: "YAML" }).click();
      await page.locator("#main textarea.yaml-editor").waitFor();
      await page.locator("#main .flow-validation.ok", { hasText: "Valid" }).waitFor();
    },
  },
  "run-dialog": {
    act: async (page) => {
      await page.locator("#main button", { hasText: "Test run" }).click();
      await page.locator("#modal-root .modal-head h2").waitFor();
    },
  },
  // the run pages redraw their head when the run summary arrives; wait for it ("Workspace") before the paths are rewritten
  "run-log": {
    act: async (page) => {
      await page.locator('#main [data-tab="details"]').click();
      await page.locator('#main [data-tab="details"].on').waitFor();
      await page.locator('#main [data-section="log"] > summary').click();
      await page.locator("#main pre.log", { hasText: "waiting for approval: Go?" }).waitFor();
      await page.locator('#main dd[data-fact="tech-workspace"]').waitFor({ state: "attached" });
      // the log is below the run head: bring its section to the top of the picture
      await page.locator('#main [data-section="log"]').evaluate((e) => e.scrollIntoView({ block: "start" }));
    },
  },
  "run-steps": {
    act: async (page) => {
      await page.locator('#main [data-tab="details"]').click();
      await page.locator('#main [data-tab="details"].on').waitFor();
      await page.locator("#main .timeline").waitFor();
      await page.locator('#main dd[data-fact="tech-workspace"]').waitFor({ state: "attached" });
      await page.locator('#main [role="tablist"]').evaluate((e) => e.scrollIntoView({ block: "start" }));
    },
  },
  "run-diff": {
    large: true,
    act: async (page) => {
      await page.locator('#main [data-tab="diff"]').click();
      await page.locator("#main pre.diff").waitFor();
      await page.locator('#main dd[data-fact="tech-workspace"]').waitFor({ state: "attached" });
      await page.locator('#main [role="tablist"]').evaluate((e) => e.scrollIntoView({ block: "start" }));
    },
  },
  "watcher-form": {
    act: async (page) => {
      await page.locator("#main .toolbar button", { hasText: "+ Add watcher" }).click();
      await page.locator("#modal-root .modal-head h2").waitFor();
    },
  },
  // Your turn and Building now load with separate requests; the shot's text only proves the first
  home: {
    act: async (page) => {
      await page.locator("#main a", { hasText: "Seeded hold run" }).waitFor();
    },
  },
  "user-questions": {
    act: async (page) => {
      await page.locator("#main form.run-answer textarea").fill("Passing, failing and running. Yes, keep the filter in the browser.");
    },
  },
  releases: {
    act: async (page) => {
      await page.locator("#main", { hasText: "Build status on the board" }).waitFor();
    },
  },
  // Ask Foundry is off on the seeded server (help.enabled is not set): only this page is told it is on, so the top bar shows the button
  ask: {
    before: async (page) => {
      await page.route("**/api/help/conversations", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({ response: res, json: { ...body, enabled: true, paused: false } });
      });
    },
    act: async (page) => {
      await page.locator("#ask-btn").click();
      await page.locator("#ask-drawer").waitFor();
      await page.locator("#ask-question").waitFor();
    },
  },
  preferences: {
    act: async (page) => {
      await page.locator("#account-summary").click();
      await page.locator("#view-switch select").waitFor();
      await page.locator("#user button", { hasText: "Appearance" }).click();
      await page.locator("#modal-root .modal-head h2", { hasText: "Appearance" }).waitFor();
    },
  },
  // One picture of the five looks: the Simple Today page is taken in each look, then #main shows the five pictures side by side.
  // The frame around them is in the default look (Calm).
  looks: {
    act: async (page) => {
      await page.locator("#main .simple-home").waitFor();
      const shots: string[] = [];
      for (const [id] of LOOKS) {
        await page.evaluate((l) => {
          document.documentElement.setAttribute("data-look", l);
          dispatchEvent(new HashChangeEvent("hashchange"));
        }, id);
        await page.locator(`#main .simple-home`).waitFor();
        await page.waitForTimeout(300);
        shots.push((await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" })).toString("base64"));
      }
      await page.evaluate(({ looks, shots }) => {
        document.documentElement.setAttribute("data-look", "calm");
        const main = document.querySelector("#main")!;
        const grid = document.createElement("div");
        grid.className = "guide-looks";
        grid.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 20px;padding:8px 0";
        looks.forEach(([, label], i) => {
          const fig = document.createElement("figure");
          fig.style.cssText = "margin:0";
          const cap = document.createElement("figcaption");
          cap.textContent = label;
          cap.style.cssText = "font-weight:600;margin-bottom:6px";
          const img = document.createElement("img");
          img.src = `data:image/png;base64,${shots[i]}`;
          img.alt = `Today in the ${label} look`;
          img.style.cssText = "display:block;width:100%;height:auto;border:1px solid rgba(0,0,0,.15);border-radius:8px";
          fig.append(cap, img);
          grid.append(fig);
        });
        main.replaceChildren(grid);
      }, { looks: LOOKS, shots });
      await page.locator("#main .guide-looks img").last().evaluate((img: HTMLImageElement) => img.decode());
    },
  },
  // The real answer depends on the programs of the host; the guide shows a computer where everything is ready
  "setup-check": {
    before: async (page) => {
      await page.route("**/api/setup-check*", async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as { items: Record<string, unknown>[] };
        const items = body.items.map(({ command: _c, link: _l, ...it }) => ({ ...it, state: "ok", explain: "" }));
        await route.fulfill({ response: res, json: { ...body, items, ready: true, problems: 0, unchecked: 0 } });
      });
    },
  },
};
