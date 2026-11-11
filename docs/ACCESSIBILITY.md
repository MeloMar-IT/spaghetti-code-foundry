# Accessibility

This is the accessibility statement of Spaghetti Code Foundry. The same text is served in the app at `/accessibility.html` (the **Accessibility** link in the account menu). Manual check scripts are in [ACCESSIBILITY_SCRIPTS.md](ACCESSIBILITY_SCRIPTS.md).

## Standard

Spaghetti Code Foundry aims to meet WCAG 2.2 AA.

## What is checked

An automatic test checks the screens of nine critical journeys for both roles on every change. It fails on a serious problem.

The tests:

| Test | What it checks |
|---|---|
| `tests/ui-a11y-journeys.test.ts` | The gate. Draws the screens of each critical journey in order, inside the page shell of each role, and fails on any `serious` violation from `audit()`. Also checks that the statement page and this file name the same standard and reporting address, and that every journey in the scripts file has a test. |
| `tests/ui-a11y.test.ts` | The rule checker and the pages of the UI. |
| `tests/ui-a11y-admin.test.ts` | The admin pages. |
| `tests/ui-a11y-editor.test.ts` | The flow editor. |
| `tests/ui-a11y-equivalents.test.ts` | The form editor and the YAML editor as the equivalent of the flow graph. |
| `tests/ui-a11y-live.test.ts` | Live updates and what is announced. |
| `tests/ui-a11y-looks.test.ts` | The contrast of every colour pair in the Calm and Midnight looks, in light and dark. |
| `tests/ui-a11y-redesign.test.ts` | The sidebar in all three views, the phase strip, the box for a change, and dark-mode colours of their styles. |

The journeys are: sign in; start work; follow a run and read its log; approve or reject; answer planner questions; open a board card (admin only); edit and save a flow (admin only); add a repository; add a user (admin only).

The rule checker (`tests/helpers/a11y.ts`) has seven rules: `click-needs-key`, `control-name`, `dialog-name`, `field-label`, `focusable-hidden`, `img-name` and `no-positive-tabindex`.

Other tests check the sidebar, the phase strip and the box for a change in all three views, and that the main pages do not scroll sideways at 375 px in light and dark mode.

## Layout

Every page has the same frame: a sidebar on the left with Today, Changes, Ideas, Releases and Help, and a top bar with search, Ask Foundry, + New change and the account menu. The Advanced and Admin views add their extra pages below a divider in the sidebar.

Below 768 px the sidebar is a menu that opens from the menu button. Pages have one column, and nothing scrolls sideways at 375 px.

Every label calls one piece of work a change. The word issue is used only for an issue on GitHub.

## Light and dark

The Foundry follows the light or dark setting of your system. To choose yourself, open the account menu, then Appearance, and pick System, Light or Dark. The choice is kept in this browser.

Both themes use the same colour tokens, and a test checks the contrast of every pair in both.

## Keyboard

- Skip to content is the first control. It moves focus to the page.
- Tab goes through the top bar, the sidebar and the page in order. The current page is marked in the sidebar.
- On a narrow screen the menu button opens the sidebar. Tab stays inside it, and Escape closes it and returns focus to the menu button.
- The progress of a change is a list of five phases: Understand, Plan, Build, Check and Deliver. The current phase is marked for screen readers.
- In the box What would you like to change?, Ctrl+Enter or ⌘+Enter sends what you wrote.
- A dialog keeps focus inside it. Escape closes it and returns focus to where you were.

## Known limits

- The rule checker does not run in a browser, and nothing was tested with a screen reader. The width, theme and keyboard checks run in Chromium with Playwright.
- The rule checker is our own small one. It is not axe and it covers seven rules.
- The flow graph is a visual editor. The form editor and the YAML editor do the same work.
- Colour contrast is computed for the colour tokens only, not for every screen.
- The Work page of the new interface is not in the checks yet.

When a new surface lands (the palette, tabs or drawers, or the Work page), it must add its screen to `JOURNEYS` in `tests/ui-a11y-journeys.test.ts`.

## Report a problem

Open a GitHub issue with the label `accessibility` at [https://github.com/MeloMar-IT/spaghetti-code-foundry/issues](https://github.com/MeloMar-IT/spaghetti-code-foundry/issues). This link leaves the Foundry.

The address is the `bugs.url` of `package.json`. A test fails when this file and the page differ.

## The page needs no sign-in

`/accessibility.html` is a static file, served like the rest of `ui/` before any sign-in. It holds no data of the Foundry, so it needs no rule in `src/server/permissions.ts`.
