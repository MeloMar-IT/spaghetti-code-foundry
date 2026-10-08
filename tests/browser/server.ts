import "../setup.js"; // must stay the first import: temporary FACTORY_HOME, cleaned environment
import { largeFromEnv, startSeeded } from "./seed.js";

// The browser tests start this as a child process: it prints one line with the seed and runs until it is told to stop.
try {
  const seeded = await startSeeded({ large: largeFromEnv(process.env) });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await seeded.close();
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void stop());
  process.on("disconnect", () => void stop());
  const { close: _close, ...data } = seeded;
  process.stdout.write(`UI_TEST_SEED ${JSON.stringify(data)}\n`);
} catch (e) {
  process.stderr.write(`could not start the seeded server: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
}
