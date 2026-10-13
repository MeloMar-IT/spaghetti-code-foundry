/** The widths the layout rules are proven at, in CSS pixels. Defined here once. */
export const WIDTHS = [360, 768, 1024, 1440] as const;
export type Width = (typeof WIDTHS)[number];

/** The height of every test window. */
export const VIEW_HEIGHT = 900;

/** True where the navigation sits in the drawer behind the menu button (the narrowest width only). */
export const usesDrawer = (width: number): boolean => width <= 767; // BREAKPOINTS.compact in ui/viewport.js

/** The essential journeys, in the order of the results table in docs/ui-redesign/measurement.md. */
export const ESSENTIAL = ["Sign in", "Find what needs me", "Start work", "Diagnose a failed run", "Board", "Refine", "Repositories", "Sign out"] as const;
export type EssentialName = (typeof ESSENTIAL)[number];

export interface Variant { width: Width; touch: boolean; label: string }
/** 360 and 768 as touch devices, 1024 and 1440 with a mouse; `label` is the column head of the results table. */
export const VARIANTS: readonly Variant[] = WIDTHS.map((width) => ({ width, touch: width < 1024, label: width < 1024 ? `${width} touch` : `${width}` }));
