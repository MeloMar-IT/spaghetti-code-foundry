import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRedactCache } from "../src/credentials/redact.js";
import { addCredential, credentialsPath } from "../src/credentials/store.js";
import { canonicalJson } from "../src/evidence/canonical.js";
import { type TelemetryEvent } from "../src/telemetry/envelope.js";
import { privateTelemetry } from "../src/telemetry/privacy.js";
import { resetTelemetry } from "../src/telemetry/telemetry.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

// built at run time, so no secret-shaped text is in this file
const STORED = ["tok", "Zq7wLm3xPv9sKd2f"].join("-");
const TOKEN = `ghp_${"a1B2".repeat(9)}`;

let home: string;
let saved: string | undefined;
let kc: FakeKeychain;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "telemetry-privacy-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  resetRedactCache();
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  resetRedactCache();
  resetTelemetry();
  rmSync(home, { recursive: true, force: true });
});

const store = (secret: string) => addCredential({ userId: randomUUID(), type: "token", name: "t", secret }, { ownerOk: () => true });
const breakStore = () => {
  mkdirSync(join(credentialsPath(), ".."), { recursive: true });
  writeFileSync(credentialsPath(), "{ this is not the store");
  resetRedactCache();
};

const event = (extra: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  version: 1, id: "ev:r1:ev-000001", time: "2026-03-01T10:00:00.000Z", kind: "step", name: "step.started", runId: "r1", evidence: { id: "ev-000001", seq: 1 },
  step: { id: "build", visit: 1, type: "shell" }, ...extra,
});

describe("telemetry privacy", () => {
  it("keeps a clean event as it is", () => {
    const r = privateTelemetry(event());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.line).toBe(canonicalJson(event()));
      expect(r.event.redacted).toBeUndefined();
    }
  });

  it("drops a field that holds a stored credential and names it", () => {
    store(STORED);
    const r = privateTelemetry(event({ step: { id: STORED, visit: 1, type: "shell" } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.step).toBeUndefined();
      expect(r.event.redacted).toEqual(["step"]);
      expect(r.line).not.toContain(STORED);
    }
  });

  it("drops a branch that looks like a token", () => {
    const r = privateTelemetry(event({ branch: TOKEN }));
    expect(r.ok && r.event.branch).toBeUndefined();
    expect(r.ok && r.event.redacted).toEqual(["branch"]);
    expect(r.ok && r.line).not.toContain(TOKEN);
  });

  it("drops a field that matches a configured pattern and keeps the event", () => {
    const r = privateTelemetry(event({ flow: { name: "internal-alpha" } }), { patterns: ["internal-[a-z]+"] });
    expect(r.ok && r.event.flow).toBeUndefined();
    expect(r.ok && r.event.redacted).toEqual(["flow"]);
    expect(r.ok && r.event.step).toBeDefined();
  });

  it("lists several dropped fields in the order of the field list", () => {
    const r = privateTelemetry(event({ branch: TOKEN, flow: { name: `x ${TOKEN}` } }));
    expect(r.ok && r.event.redacted).toEqual(["flow", "branch"]);
  });

  it("drops the event when the run id or the id holds a credential", () => {
    store(STORED);
    expect(privateTelemetry(event({ runId: STORED }))).toEqual({ ok: false, reason: "identity" });
    expect(privateTelemetry(event({ id: `ev:${STORED}:ev-000001` }))).toEqual({ ok: false, reason: "identity" });
  });

  it("drops the event when only the final check sees a change", () => {
    expect(privateTelemetry(event({ kind: "run", name: "run.created" }), { patterns: ["run\\.created"] })).toEqual({ ok: false, reason: "privacy" });
  });

  it("drops the event when the stored credentials cannot be read", () => {
    breakStore();
    expect(privateTelemetry(event())).toEqual({ ok: false, reason: "privacy" });
  });

  it("asks the store for every event", () => {
    expect(privateTelemetry(event({ step: { id: STORED, visit: 1, type: "shell" } })).ok).toBe(true);
    store(STORED);
    const r = privateTelemetry(event({ step: { id: STORED, visit: 1, type: "shell" } }));
    expect(r.ok && r.event.step).toBeUndefined();
  });
});
