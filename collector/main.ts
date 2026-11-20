import { isAbsolute } from "node:path";
import { DEFAULT_LIMITS } from "./limits.js";
import { createCollector } from "./server.js";

// The entry point of the receiver (#890): reads the environment once, listens, and shuts down on SIGTERM/SIGINT.

const SHUTDOWN_MS = 10_000;

function fail(msg: string): never {
  console.error(`collector: ${msg}`);
  process.exit(1);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const config = Object.freeze({
  dataDir: process.env.COLLECTOR_DATA_DIR ?? "",
  host: process.env.COLLECTOR_HOST || "127.0.0.1",
  port: intEnv("COLLECTOR_PORT", 8790, 1, 65535),
  totalPerHour: intEnv("COLLECTOR_TOTAL_PER_HOUR", DEFAULT_LIMITS.totalPerHour, 1, 1_000_000),
});
if (!config.dataDir || !isAbsolute(config.dataDir)) fail("COLLECTOR_DATA_DIR must be set to an absolute path");

const collector = createCollector({ dataDir: config.dataDir, limits: { ...DEFAULT_LIMITS, totalPerHour: config.totalPerHour } });

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    console.error("collector: shutdown took too long");
    process.exit(1);
  }, SHUTDOWN_MS);
  deadline.unref();
  collector.close().then(
    () => clearTimeout(deadline),
    (e: unknown) => {
      console.error(`collector: shutdown failed: ${(e as Error)?.name ?? "Error"}`);
      process.exitCode = 1;
    },
  );
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

try {
  await collector.start();
  await new Promise<void>((resolve, reject) => {
    collector.server.once("error", reject);
    collector.server.listen(config.port, config.host, () => resolve());
  });
  console.log(`collector: listening on ${config.host}:${config.port}`);
} catch (e) {
  fail(`could not start: ${(e as Error)?.message ?? "error"}`);
}
