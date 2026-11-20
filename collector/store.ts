import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ShareReportSchema, type ShareReport } from "../src/metrics-share/report.js";
import { MAX_BODY_BYTES, isInstallId } from "./check.js";

// The data folder of the receiver (#890): reports/<install>/<day>.json, one file per install and day, holding the parsed
// report only. A save writes a temporary file and renames it, so a reader never sees half a report.

export const RETENTION_DAYS = 400;
const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const TMP_FILE = /\.tmp$/;

/** Points where a test can pause the store. */
export interface StoreHooks {
  /** After the temporary file is written, before the rename. */
  afterTmpWrite?: () => Promise<void>;
}

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export class ReportStore {
  readonly reportsDir: string;
  private readonly hooks: StoreHooks;

  constructor(dataDir: string, hooks: StoreHooks = {}) {
    this.reportsDir = join(dataDir, "reports");
    this.hooks = hooks;
  }

  /** Checks that the reports folder can be created and read; throws otherwise. */
  async ready(): Promise<void> {
    await mkdir(this.reportsDir, { recursive: true, mode: 0o700 });
    await readdir(this.reportsDir);
  }

  private installDir(install: string): string {
    if (!isInstallId(install)) throw new Error("bad install id");
    return join(this.reportsDir, install);
  }

  async save(report: ShareReport): Promise<void> {
    const dir = this.installDir(report.install);
    if (!DAY_FILE.test(`${report.day}.json`)) throw new Error("bad day");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${report.day}.json`);
    const tmp = join(dir, `${report.day}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(report), { mode: 0o600, flag: "wx" });
      await this.hooks.afterTmpWrite?.();
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async deleteInstall(install: string): Promise<void> {
    await rm(this.installDir(install), { recursive: true, force: true });
  }

  private async installs(): Promise<string[]> {
    try {
      return (await readdir(this.reportsDir)).filter(isInstallId).sort();
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
  }

  private async files(install: string): Promise<string[]> {
    try {
      return (await readdir(join(this.reportsDir, install))).sort();
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
  }

  /** Every stored report that is a regular file, small enough, valid, and stored under its own install and day. */
  async list(): Promise<ShareReport[]> {
    const out: ShareReport[] = [];
    for (const install of await this.installs()) {
      for (const name of await this.files(install)) {
        const day = DAY_FILE.exec(name)?.[1];
        if (!day) continue;
        const file = join(this.reportsDir, install, name);
        try {
          const st = await lstat(file);
          if (!st.isFile() || st.size > MAX_BODY_BYTES) continue;
          const parsed = ShareReportSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
          if (parsed.success && parsed.data.install === install && parsed.data.day === day) out.push(parsed.data);
        } catch (e) {
          if (missing(e) || e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
    return out;
  }

  /** Removes day files older than RETENTION_DAYS, leftover temporary files and empty install folders. Returns the files removed. */
  async prune(now: Date): Promise<number> {
    const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const oldest = today - RETENTION_DAYS * DAY_MS;
    let removed = 0;
    for (const install of await this.installs()) {
      const names = await this.files(install);
      let left = names.length;
      for (const name of names) {
        const day = DAY_FILE.exec(name)?.[1];
        const old = day !== undefined && Date.parse(`${day}T00:00:00.000Z`) < oldest;
        if (!old && !TMP_FILE.test(name)) continue;
        await rm(join(this.reportsDir, install, name), { force: true });
        removed++;
        left--;
      }
      if (left === 0) await rmdir(join(this.reportsDir, install)).catch(() => undefined);
    }
    return removed;
  }
}
