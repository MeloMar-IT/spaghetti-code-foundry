# Brand files

The logo is the spaghetti-flame mark: a flame of noodles around `</>`. It is always shown next to the
name "Spaghetti Code Foundry", which is live text in the site or app font, never an image.

## Files

| File | What it is | Where it is used |
|---|---|---|
| `mark-on-dark.svg` | The mark in `#f08a50`, for dark backgrounds | The reference drawing; the same paths are inline in the website and the app |
| `mark-on-light.svg` | The mark in `#c2410c`, for light backgrounds | The reference drawing for light backgrounds |
| `source/logo.jpg` | The owner's logo artwork | Reference only; never shipped and never scaled up |
| `source/mascot.jpg` | The owner's mascot artwork | Reference only; never shipped itself; the web versions are made from it |
| `../../website/static/brand/character-1x.webp`, `character-2x.webp` | Web versions of the mascot (WebP, 1× and 2×) | The website home and "not found" pages (`/brand/…`) |
| `../../website/static/brand/character-1x.png`, `character-2x.png` | The same as PNG fallbacks (1× and 2×) | The website home and "not found" pages (`/brand/…`) |
| `../../website/static/favicon.svg` | The favicon: a solid flame with a `</>` cut out, on a dark tile | The website (`/favicon.svg`) |
| `../../ui/favicon.svg` | A byte copy of the website favicon | The app (`/favicon.svg`) |

The website favicon and the app favicon must stay byte-identical; `tests/brand.test.ts` checks this.

## Rules

- Use the mark next to the name, not alone, except as the favicon.
- Use the dark-background version on dark backgrounds and the light-background version on light ones.
- In the website and the app the mark is inline SVG with `stroke="currentColor"`, so it takes the theme
  accent. Do not add a second colour.
- ASSUMED (not in the issue; check with the owner): do not recolour, stretch, rotate or add effects to the mark.
- ASSUMED (not in the issue; check with the owner): do not scale up the JPG sources. They are for reference only.

## Character

The Foundry's character has the working name **Al Dente**, the Foundry's forge hand. This README is the one place to rename it.

- **Who it is:** a cheerful forge hand made of spaghetti, in a leather apron, who helps build your changes.
- **How it talks:** friendly, short and practical.
- **What it never does:** joke about failures, or use slang in error messages.

### Where it appears

Only on the website home page, the website "not found" page, the app's empty states ("nothing needs you", "no runs yet") and the Ask Foundry avatar.

Never next to failures, security notices, or Your turn items that ask for a decision.

## Changing the mark

The inline copies in `website/lib/layout.mjs`, `ui/index.html` and `ui/user/index.html` must match the
paths of `mark-on-dark.svg`. `tests/brand.test.ts` fails when they differ.
