/** The widths the layout rules are proven at, in CSS pixels. Defined here once. */
export const WIDTHS = [360, 768, 1024, 1440] as const;
export type Width = (typeof WIDTHS)[number];

/** The height of every test window. */
export const VIEW_HEIGHT = 900;

/** True where the navigation sits in the drawer behind the menu button (the narrowest width only). */
export const usesDrawer = (width: number): boolean => width <= 760;
