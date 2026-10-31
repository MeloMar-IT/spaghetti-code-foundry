import { z } from "zod";

/** The views of the web interface. A view changes only what the display shows, never what the server allows. */
export const VIEWS = ["simple", "advanced", "admin"] as const;
export type View = (typeof VIEWS)[number];
export const ViewSchema = z.enum(VIEWS);
export const isView = (x: unknown): x is View => typeof x === "string" && (VIEWS as readonly string[]).includes(x);

type Role = "admin" | "user";

/** The views a role may choose. */
export function viewsFor(role: Role): View[] {
  return role === "admin" ? [...VIEWS] : ["simple", "advanced"];
}

/** The view of an account that has made no choice. */
export const defaultView = (role: Role): View => (role === "admin" ? "admin" : "advanced");

/** The view in effect: the stored one when the role may use it, else the default of the role. */
export function viewOf(u: { role: Role; view?: View }): View {
  return u.view !== undefined && viewsFor(u.role).includes(u.view) ? u.view : defaultView(u.role);
}
