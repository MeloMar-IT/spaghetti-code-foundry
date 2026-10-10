import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must behave the same everywhere — also inside a factory run, which sets FACTORY_* variables
// and a git pre-push hook (through GIT_CONFIG_*) that blocks pushes to "main". The tests push to
// fake remotes and set their own FACTORY_* values, so drop the inherited ones
// (also SCF_*: an inherited SCF_HOME would beat the test home) and a developer's own Codex key and folder.
for (const k of Object.keys(process.env)) {
  if (/^(FACTORY_|SCF_|GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$|GH_TOKEN$|GITHUB_TOKEN$|CODEX_API_KEY$|CODEX_HOME$)/.test(k)) delete process.env[k];
}
// Keep tests away from the real ~/.claude-factory (config, hooks, learnings, locks) and notifications.
process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-home-"));
process.env.FACTORY_LOCK_DIR = join(process.env.FACTORY_HOME, "locks");
process.env.FACTORY_NO_NOTIFY = "1";
// Suites that start failing runs without a fake `claude` must never reach a real one for the failure summary.
process.env.FACTORY_NO_FAILURE_MODEL = "1";
process.env.FACTORY_TRANSIENT_RETRY_MS = "20,20"; // retries of a briefly unavailable service: quick in tests
// A user's shell steps are held in an OS sandbox on macOS (and refused where that is not possible). Suites run as before on every
// system; the macOS sandbox tests delete this variable themselves.
process.env.SCF_USER_SANDBOX = "off";
// Steps of a user's run get a short environment; the tests' own FAKE_* switches and the area-lock poll must still reach them.
process.env.FACTORY_STEP_ENV_PASS = "FAKE_*,AREA_LOCK_POLL_MS";
