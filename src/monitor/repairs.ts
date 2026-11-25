/** What the Foundry fixes alone (`auto`) and what it asks the owner about first (`ask`). Imports nothing, so anything can use it. */
export type RepairClass = "auto" | "ask";
export const REPAIR_CLASSES: readonly RepairClass[] = ["auto", "ask"];
export const isRepairClass = (x: unknown): x is RepairClass => x === "auto" || x === "ask";

/** The rule in two sentences, for the app and the user guide. */
export const REPAIR_RULE =
  "The Foundry fixes a problem alone when the fix can be undone and touches only its own work. It asks you first for governance, security, secrets, force pushes, deleting data, merging or releasing to main, spending limits and turning a check off, except where you already agreed by turning on Hotfixes, the daily release or automatic demotion.";

export interface Repair { name: string; repair: RepairClass; description: string; where: string }

/** The automatic repairs the Foundry does today. */
export const REPAIRS: readonly Repair[] = [
  { name: "retry-after-time-limit", repair: "auto", where: "src/engine/auto-retry.ts", description: "A story run that ran out of time stops instead of failing, and the watcher starts it again." },
  { name: "bug-story", repair: "auto", where: "src/monitor/report.ts", description: "A problem that lasts gets one bug story on GitHub, which the watcher builds first." },
  { name: "lower-autonomy", repair: "auto", where: "src/governance/auto-demote.ts", description: "When automatic demotion is on, a new qualifying serious finding lowers the named component by one autonomy level." },
  { name: "start-service", repair: "auto", where: "src/services/supervisor.ts", description: "A managed service that is not running is started again." },
  { name: "safe-restart", repair: "auto", where: "src/server/api-restart.ts", description: "After a new version, a moved data folder or a changed setting, the server restarts once no run is active." },
  { name: "correct-labels", repair: "auto", where: "src/queue/watcher.ts", description: "An issue's status label that does not match its newest run is corrected." },
  { name: "completed-dependency", repair: "auto", where: "src/queue/deps.ts", description: "A dependency on an issue closed as completed counts as done." },
  { name: "hotfix-merge", repair: "auto", where: "scripts/build-flows.mjs", description: "With Hotfixes on, a bug story is merged into main and then into develop." },
];

/** The names of entries without a valid class (empty when all are fine). */
export function invalidRepairClasses(list: readonly { name: string; repair?: unknown }[]): string[] {
  return list.filter((e) => !isRepairClass(e.repair)).map((e) => e.name);
}
