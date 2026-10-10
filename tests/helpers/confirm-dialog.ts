import type { FakeElement } from "./fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = () => (document as any).getElementById("modal-root") as FakeElement;

const buttonsOf = (el: FakeElement): FakeElement[] => el.all("button").filter((b) => b.getAttribute("aria-label") !== "Close");

/** True for the dialog of `confirmDialog`: Cancel and one more button, a text, and no field, list or plan. */
const isConfirm = (el: FakeElement): boolean =>
  buttonsOf(el).length === 2 && buttonsOf(el).some((b) => b.textContent === "Cancel") && !["input", "textarea", "select", "ol", "ul"].some((t) => el.all(t).length);

/** The text of the dialog that is open, or undefined. */
export const dialogText = (): string | undefined => (root().children.length ? root().all("p")[0]?.textContent : undefined);

/** Presses the confirm button (`yes`) or Cancel of the dialog that is open, then lets promises run. */
export async function answerDialog(yes: boolean): Promise<void> {
  const buttons = buttonsOf(root());
  if (!buttons.length) throw new Error("no dialog is open");
  const cancel = buttons.find((b) => b.textContent === "Cancel");
  (yes ? buttons[buttons.length - 1]! : cancel!).click();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Answers every dialog that opens: `answer(text)` is asked with the first line of the dialog. Returns the function that stops it.
 * The button is pressed in a microtask, so a test awaits its click as it does for any other change.
 */
export function autoDialog(answer: (text: string) => boolean): () => void {
  const el = root() as any;
  const real = el.replaceChildren;
  el.replaceChildren = (...nodes: unknown[]) => {
    real.apply(el, nodes);
    if (!nodes.length) return;
    queueMicrotask(() => {
      if (!el.children.length || !isConfirm(el)) return;
      const text = el.all("p")[0]?.textContent ?? "";
      void answerDialog(answer(text));
    });
  };
  return () => {
    el.replaceChildren = real;
  };
}
