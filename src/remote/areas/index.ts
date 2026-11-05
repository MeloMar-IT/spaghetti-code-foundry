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
  "GET setup-check": "the Setup check page; on the machine itself `scf doctor --simple` prints the same",
  "POST onboarding/sign-in": "starts the sign-in of Claude Code or Codex on the server's computer; done from the Setup check page, or in a terminal with `claude` then `/login`, or `codex login`",
  "POST onboarding/test-call": "one tiny call that checks Claude Code or Codex works; done from the Setup check page",
  "GET onboarding/agents": "the onboarding answers about Claude Code and Codex (#769); there is no command for them yet",
  "PUT onboarding/agents": "saves the onboarding answers about Claude Code and Codex and writes the settings they give (#769); there is no command for them yet",
  "GET starters": "the starters a new project can be made from; no page uses it yet (the onboarding pages will call it), the command line has no command for it yet",
  "POST starters/:id/project": "makes a project folder on the server's computer from a starter and connects it; no page uses it yet (the onboarding pages will call it), the command line has no command for it yet",
  "GET plugins/ui": "the pages and menu links plugins add to the web interface (#787); the command line has no pages",
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
  "GET governor": "the Load governor card of the Overview page; the command line reads the same with `scf governor report` and `scf governor status` on the data folder",
  "GET busy":"the state of busy mode, shown by the switch in the top bar",
  "POST busy": "switches busy mode on; done with the switch in the top bar",
  "DELETE busy": "switches busy mode off; done with the switch in the top bar",
  "GET restart": "the state the Settings page shows next to its restart box; the restart itself is asked for in the interface",
  "POST restart": "restarts the server when no story is running; asked for in the interface after a settings change",
  "DELETE restart": "cancels that wait; done in the interface",
  "POST repos/:id/move-to-github": "moves a local project to GitHub (#806, #807); the Move to GitHub dialog under My repositories and the Simple project page use it, so there is no command line use yet",
  "POST repos/:id/publish-remote": "the owner's Yes, publish for the plain push to the folder's remote (#796); the Run settings dialog under Advanced uses it, so there is no command line use yet",
  "GET repos/:id/epics":"the data of the Epics view; no command line use yet (a later part of #408 adds the view)",
  "GET repos/:id/epics/:issue": "the data of the epic page; no command line use yet (a later part of #408 adds the view)",
  "POST repos/:id/preview": "starts a preview of the project (#789, part of #608); the Try it page that uses it comes in a later part",
  "GET repos/:id/preview": "the state of that preview (#789); no command line use yet",
  "DELETE repos/:id/preview": "stops that preview (#789); no command line use yet",
  "GET promotions": "which component versions are promoted and what blocks the others; shown in the flow editor and on the Settings page, and the command line reads the same with `scf promote <kind> <id>` on the data folder",
  "GET admin/components": "the governance of each component for the Settings page; the command line reads the same with `scf components` on the data folder",
  "POST promotions": "promotes a component with a passing report; the command line does it with `scf promote <kind> <id> --report <id>` on the data folder",
  "GET settings":"the description the Settings page builds its controls from; no command line use",
  "GET skills/lifecycle": "the skill lifecycle states; the command line reads them with `scf skills lifecycle` on the data folder",
  "POST skills/lifecycle": "sets a skill lifecycle state; the command line does it with `scf skills lifecycle` on the data folder",
  "POST skills/lifecycle/allow-run": "lets one run go on with a quarantined skill; the command line does it with `scf skills allow-run` on the data folder",
  "POST settings/reset": "the \"Back to default\" button of the settings pages; no command line use yet",
};
