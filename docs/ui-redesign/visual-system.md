# Visual system: icons, status, theme and density

Part 2 of the visual system (#323); part 3 (#324) is the last section. The tokens and contrast results of part 1 (#322) are in `ui/tokens.css`.
Icons live in `ui/icons.js`.

## Icons

All icons come from [Lucide](https://lucide.dev) (ISC licence). The path data was written from memory, so an icon
may differ slightly from the release; check them in a browser. New icons come from Lucide only. The step-type
glyphs in `ui/step-types.js` stay for now.

| Name | Use |
|---|---|
| `check` | A confirmed choice |
| `x` | Close or remove |
| `circle` | Neutral status |
| `circle-dot` | Accent status |
| `circle-check` | Success |
| `circle-x` | Danger; a failed tool call |
| `triangle-alert` | Warning; a flow with errors |
| `info` | Information |
| `loader-circle` | Running (class `spin`) |
| `clock` | Waiting |
| `ban` | Disabled, cancelled |
| `circle-help` | Help mark |
| `chevron-down` | Open or close a section |
| `external-link` | A link that opens another site |
| `sun` | Light theme |
| `moon` | Dark theme |
| `monitor` | Theme follows the system |
| `rows-2` | Comfortable density |
| `rows-3` | Compact density |

## Status semantics

| Semantic | Icon |
|---|---|
| `neutral` | `circle` |
| `accent` | `circle-dot` |
| `success` | `circle-check` |
| `warning` | `triangle-alert` |
| `danger` | `circle-x` |
| `info` | `info` |
| `running` | `loader-circle` |
| `waiting` | `clock` |
| `disabled` | `ban` |

No two semantics share an icon. `KIND_SEMANTIC` maps every `NextKind` to a semantic. It is presentation only: the
status text and its meaning come from the server (`src/words.ts`). An unknown kind is `neutral`.

## When an icon needs a label

- A status always has text. The icon never replaces it.
- A decorative icon next to its text has no label and is `aria-hidden`.
- An icon alone is allowed only on a button with `aria-label` and `title`, made with `iconButton`, which refuses an empty label.
- An icon that carries meaning without text next to it has a label (`role="img"` and `aria-label`), for example "Failed" on a failed tool call and "Has errors" on a flow in the sidebar.

## Theme and density switch

The **Appearance** dialog (`ui/prefs.js`, a button next to **Change password**) sets `data-theme` (`system`, `light`,
`dark`) and `data-density` (`comfortable`, `compact`) on `<html>`. `system` and `comfortable` match no CSS rule, so
they are the token defaults.

- **Storage.** `localStorage` key `scf.prefs`: `{ v: 1, last: { theme, density }, accounts: { "<account id>": { theme, density } } }`.
  A read gives the account's choice, else `last`, else System and Comfortable. Every write reads first (tabs share the
  store), sets the account and `last`, and keeps at most 20 accounts (the oldest are dropped). Every storage failure is
  swallowed.
- **No flash.** `ui/prefs-boot.js` is a classic script in `<head>` of both `index.html` files, before the stylesheets.
  It applies `last` only, because the account is not known yet, so it also covers the sign-in form. After sign-in,
  `initPrefs` applies the account's own choice.
- **Not by colour alone.** Each option is a button with `aria-pressed`, class `on` and a `check` icon on the chosen one.
  Icons: `monitor`, `sun`, `moon`, `rows-2`, `rows-3`.
- Other open tabs pick up a change on reload. The switch moves into the account menu when the shell has one.
