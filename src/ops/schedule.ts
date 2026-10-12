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

/** Waits without giving the processor away to other work of this process: the install command has nothing else to do. */
const sleepSync = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Loads a login agent whose old copy was just booted out. launchd answers `bootout` before the old job is gone,
 * and a `bootstrap` in that moment fails with "Input/output error": so wait until `print` no longer finds the job
 * (5 seconds at most), then try `bootstrap` up to three times. Throws the last error.
 */
export function loadAgent(host: ServiceHost, label: string, path: string, pause: (ms: number) => void = sleepSync) {
  for (let i = 0; i < 25; i++) {
    try {
      host.launchctl(["print", `${host.domain}/${label}`]);
    } catch {
      break; // gone
    }
    pause(200);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      host.launchctl(["bootstrap", host.domain, path]);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      pause(1000);
    }
  }
}

export function installJob(job: Job, cliPath: string, host: ServiceHost = macHost(), pause?: (ms: number) => void): string {
  if (host.platform !== "darwin") throw new Error(`scf ${job.name} install supports macOS (launchd) only; elsewhere run \`scf ${job.name} run\` from cron`);
  mkdirSync(host.agentsDir, { recursive: true });
  mkdirSync(jobDir(job.name), { recursive: true });
  const path = plistPath(host, job.name);
  bootout(host, job.name);
  host.writeFile(path, jobPlist(job, { cliPath, logFile: join(jobDir(job.name), `${job.name}.log`), home: process.env.SCF_HOME ?? process.env.FACTORY_HOME }));
  loadAgent(host, labelOf(job.name), path, pause);
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

/**
 * "loaded": launchd has the job and runs it. "not loaded": its file is there but launchd does not have it (an
 * install that failed half way) — nothing runs. Where launchd cannot be asked (not macOS, no launchctl) the file decides.
 */
export function jobState(name: string, host: ServiceHost = macHost()): "loaded" | "not loaded" | "not installed" {
  const file = existsSync(plistPath(host, name));
  if (host.platform === "darwin") {
    try {
      host.launchctl(["print", `${host.domain}/${labelOf(name)}`]);
      return "loaded";
    } catch (e) {
      // launchctl ran and said no (it ends with a number); anything else: it could not be asked
      if (typeof (e as { status?: unknown }).status === "number") return file ? "not loaded" : "not installed";
    }
  }
  return file ? "loaded" : "not installed";
}

export const jobInstalled = (name: string, host: ServiceHost = macHost()) => jobState(name, host) === "loaded";

function describe(sec: number): string {
  return sec % 3600 === 0 ? `${sec / 3600} hour${sec === 3600 ? "" : "s"}` : `${Math.round(sec / 60)} minute${sec === 60 ? "" : "s"}`;
}
