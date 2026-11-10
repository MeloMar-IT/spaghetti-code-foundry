import type { FakeElement } from "./fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The radios of the published flows (the "No flow" choice is left out). */
export const flowRadios = (root: FakeElement): FakeElement[] =>
  root.all("input").filter((r) => r.attrs.type === "radio" && r.attrs.name === "flow" && (r as any).value !== "");

/** Opens "Advanced" and chooses a flow there (the first one, or `name`). Without a flow the page makes a plan. */
export async function chooseFlow(main: FakeElement, name?: string): Promise<void> {
  const radios = main.all("input").filter((r) => r.attrs.type === "radio" && r.attrs.name === "flow" && (r as any).value !== "");
  if (!name && radios.some((r) => (r as any).checked)) return; // a flow came back from the draft
  const radio = name ? radios.find((r) => (r as any).value === name) : radios[0];
  if (!radio) return;
  (radio as any).checked = true;
  radio.fire("change");
  await flush();
}

/** Wraps `renderStart`: the page is rendered, then the first flow is chosen under Advanced. */
export function startWith(render: (main: any, opts: any) => Promise<() => void>) {
  return async (main: FakeElement, opts: object = {}) => {
    const cleanup = await render(main, opts);
    await chooseFlow(main);
    return cleanup;
  };
}
