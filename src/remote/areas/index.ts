import type { Cmd } from "../spec.js";
import { HELP } from "./help.js";
import { PEOPLE } from "./people.js";
import { REFINE } from "./refine.js";
import { SETUP } from "./setup.js";
import { SYSTEM } from "./system.js";
import { WORK } from "./work.js";

/** Every command that is one call to the API, by area. Each area lives in a file of its own. */
export const ALL: Cmd[] = [...SYSTEM, ...WORK, ...SETUP, ...PEOPLE, ...REFINE, ...HELP];

/** Calls of the server that have no command, each with the reason. A test fails when a call is in neither list. */
export const API_ONLY: Record<string, string> = {
  "GET runs/:id/events": "a live stream that does not end; the command line reads a whole answer before it prints",
};
