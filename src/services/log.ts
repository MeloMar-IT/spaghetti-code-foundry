import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * The output log of one service: `<path>` and one older file `<path>.1`. Writes are split by bytes, so a file never passes
 * `max` (a multibyte character may be cut at the border). Synchronous; the caller catches errors.
 */
export class ServiceLog {
  private size: number | undefined;
  constructor(private readonly path: string, private readonly max = MAX_LOG_BYTES) {}

  write(text: string): void {
    let bytes = Buffer.from(text, "utf8");
    if (!bytes.length) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.size === undefined) {
      try {
        this.size = statSync(this.path).size;
      } catch {
        this.size = 0;
      }
    }
    while (bytes.length) {
      const room = this.max - this.size;
      if (room <= 0) {
        renameSync(this.path, `${this.path}.1`);
        this.size = 0;
        continue;
      }
      const part = bytes.subarray(0, room);
      appendFileSync(this.path, part, { mode: 0o600 });
      this.size += part.length;
      bytes = bytes.subarray(part.length);
    }
  }

  line(text: string): void {
    this.write(`--- ${new Date().toISOString()} ${text}\n`);
  }
}
