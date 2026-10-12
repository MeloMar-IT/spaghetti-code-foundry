import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";
import { macHost, type ServiceHost } from "../service.js";

/** A helper process of the Foundry that launchd starts by itself: every so many seconds, or once a day at a time. */
export interface Job {
  /** Short name; the command is `scf <name> run` and the files are in <data folder>/<name>. */
  name: string;
  everySec?: number;
  /** Local time of day, e.g. { hour: 7, minute: 30 }. */
  daily?: { hour: number; minute: number };
}

export const labelOf = (name: string) => `com.spaghetti-code-foundry.${name}`;
export const dataDir = () => process.env.FACTORY_HOME ?? FACTORY_HOME;
export const jobDir = (name: string) => join(dataDir(), name);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plistPath = (host: ServiceHost, name: string) => join(host.agentsDir, `${labelOf(name)}.plist`);

export function jobPlist(job: Job, o: { cliPath: string; logFile: string; home?: string }): string {
  const home = o.home ? `\n    <key>SCF_HOME</key><string>${esc(o.home)}</string>\n    <key>FACTORY_HOME</key><string>${esc(o.home)}</string>` : "";
  const when = job.daily
    ? `  <key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>${job.daily.hour}</integer><key>Minute</key><integer>${job.daily.minute}</integer></dict>`
    : `  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>${job.everySec ?? 3600}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${labelOf(job.name)}</string>
  <key>ProgramArguments</key>
  <array>
${[process.execPath, o.cliPath, job.name, "run"].map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
    <key>HOME</key><string>${esc(homedir())}</string>${home}
  </dict>
${when}
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(o.logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logFile)}</string>
</dict>
</plist>
`;
}

function bootout(host: ServiceHost, name: string) {
  try {
    host.launchctl(["bootout", `${host.domain}/${labelOf(name)}`]);
  } catch {
    // not loaded
  }
}

export function installJob(job: Job, cliPath: string, host: ServiceHost = macHost()): string {
  if (host.platform !== "darwin") throw new Error(`scf ${job.name} install supports macOS (launchd) only; elsewhere run \`scf ${job.name} run\` from cron`);
  mkdirSync(host.agentsDir, { recursive: true });
  mkdirSync(jobDir(job.name), { recursive: true });
  const path = plistPath(host, job.name);
  bootout(host, job.name);
  host.writeFile(path, jobPlist(job, { cliPath, logFile: join(jobDir(job.name), `${job.name}.log`), home: process.env.SCF_HOME ?? process.env.FACTORY_HOME }));
  host.launchctl(["bootstrap", host.domain, path]);
  const when = job.daily ? `every day at ${String(job.daily.hour).padStart(2, "0")}:${String(job.daily.minute).padStart(2, "0")}` : `every ${describe(job.everySec ?? 3600)}`;
  return `installed ${path}\n  runs ${when}`;
}

export function uninstallJob(name: string, host: ServiceHost = macHost()): string {
  bootout(host, name);
  const path = plistPath(host, name);
  if (!existsSync(path)) return `${name} was not installed`;
  host.removeFile(path);
  return `${name} removed`;
}

export const jobInstalled = (name: string, host: ServiceHost = macHost()) => existsSync(plistPath(host, name));

function describe(sec: number): string {
  return sec % 3600 === 0 ? `${sec / 3600} hour${sec === 3600 ? "" : "s"}` : `${Math.round(sec / 60)} minute${sec === 60 ? "" : "s"}`;
}
