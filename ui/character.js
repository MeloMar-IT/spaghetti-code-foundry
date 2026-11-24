import { h } from "./dom.js";

// The Foundry's character as a small picture. One helper, so every place draws it the same way.
// Relative imports only, so the user display can load it.

export const CHARACTER_ALT = "The Foundry's forge hand: a cheerful figure made of spaghetti, in a leather apron";
export const CHARACTER_CLASS = "scf-character";

/** kind: "empty" (a small picture in an empty state) or "avatar" (the Ask Foundry header). Anything else is "empty". */
export function character(kind = "empty") {
  const k = kind === "avatar" ? "avatar" : "empty";
  return h("picture", { class: `${CHARACTER_CLASS} ${CHARACTER_CLASS}-${k}` },
    h("source", { type: "image/webp", srcset: "/brand/character-1x.webp 1x, /brand/character-2x.webp 2x" }),
    h("img", { src: "/brand/character-1x.png", srcset: "/brand/character-1x.png 1x, /brand/character-2x.png 2x", width: "140", height: "226", alt: CHARACTER_ALT, decoding: "async" }));
}
