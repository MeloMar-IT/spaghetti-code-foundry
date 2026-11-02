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
  "GET me/view": "the view of the web interface (#595): it changes only what the interface shows; the command line has no views",
  "PUT me/view": "chooses that view; done with the switch in the top bar",
  "POST help/conversations/:id/actions": "a button of a reply in the Ask SCF drawer: it opens a page, runs a read-only check, or previews an action Ask SCF proposed (#568); the command line has none of these",
  "POST help/conversations/:id/actions/confirm": "the confirmation of an action Ask SCF proposed; done in the Ask SCF drawer (#568), not from the command line",
  "POST help/conversations/:id/actions/cancel": "the dropped token of an action Ask SCF proposed; done in the Ask SCF drawer (#568), not from the command line",
  "GET help/conversations/:id/handoffs": "the pages a reply of the Ask SCF drawer can be taken to; the command line has no page to open",
  "POST help/conversations/:id/handoffs": "records a hand-off made from the Ask SCF drawer; the command line has no page to open",
  "GET runs/:id/events": "a live stream that does not end; the command line reads a whole answer before it prints",
  "GET autonomy/history": "the changes of the autonomy levels for the Autonomy page; the command line reads the same lines with `scf audit list --action autonomy-promote` and the other `autonomy-` actions, one at a time",
  "GET outcomes": "the outcome measures for the dashboard (#157); a command for it comes with the dashboard work",
  "GET restart": "the state the Settings page shows next to its restart box; the restart itself is asked for in the interface",
  "POST restart": "restarts the server when no story is running; asked for in the interface after a settings change",
  "DELETE restart": "cancels that wait; done in the interface",
  "GET repos/:id/epics": "the data of the Epics view; no command line use yet (a later part of #408 adds the view)",
  "GET repos/:id/epics/:issue": "the data of the epic page; no command line use yet (a later part of #408 adds the view)",
  "GET promotions": "which component versions are promoted and what blocks the others; shown in the flow editor and on the Settings page, and the command line reads the same with `scf promote <kind> <id>` on the data folder",
  "GET admin/components": "the governance of each component for the Settings page; the command line reads the same with `scf components` on the data folder",
  "POST promotions": "promotes a component with a passing report; the command line does it with `scf promote <kind> <id> --report <id>` on the data folder",
  "GET settings":"the description the Settings page builds its controls from; no command line use",
  "GET skills/lifecycle": "the skill lifecycle states; the command line reads them with `scf skills lifecycle` on the data folder",
  "POST skills/lifecycle": "sets a skill lifecycle state; the command line does it with `scf skills lifecycle` on the data folder",
  "POST skills/lifecycle/allow-run": "lets one run go on with a quarantined skill; the command line does it with `scf skills allow-run` on the data folder",
  "POST settings/reset": "the \"Back to default\" button of the settings pages; no command line use yet",
};
