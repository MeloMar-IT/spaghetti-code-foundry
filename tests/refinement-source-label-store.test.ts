import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOG_LIMIT,
  RefinementError,
  clearSourceBuildLabel,
  createSessionFromIssue,
  dropSession,
  getSession,
  refinementsPath,
  setArchitectRun,
} from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ann = { id: ANN, admin: false };
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-source-label-store-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const make = () =>
  createSessionFromIssue(
    ANN,
    { repo: "acme/app", title: "T", idea: "T", source: { issue: 7, url: "https://github.com/acme/app/issues/7", title: "T", body: "", updatedAt: "2026-01-01T00:00:00.000Z", buildLabel: "Factory_go" } },
    OK,
  ).id;
const padLog = (id: string, n: number) => {
  const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
  const s = f.sessions.find((x: any) => x.id === id);
  while (s.log.length < n) s.log.push({ at: new Date().toISOString(), by: ANN, what: "renamed", detail: "x" });
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};

describe("clearSourceBuildLabel", () => {
  it("forgets the label and logs it", () => {
    const id = make();
    const s = clearSourceBuildLabel(ann, id);
    expect(s.source && "buildLabel" in s.source).toBe(false);
    expect(s.log.at(-1)).toMatchObject({ what: "source-label-removed", detail: "Factory_go" });
    expect(code(() => clearSourceBuildLabel(ann, id))).toBe("bad-state");
  });

  it("is for the owner only", () => {
    const id = make();
    expect(code(() => clearSourceBuildLabel({ id: BOB, admin: false }, id))).toBe("not-found");
    expect(code(() => clearSourceBuildLabel({ id: BOB, admin: true }, id))).toBe("not-owner");
    expect(getSession(id)!.source?.buildLabel).toBe("Factory_go");
  });

  it("refuses a dropped session", () => {
    const id = make();
    dropSession(ann, id);
    expect(code(() => clearSourceBuildLabel(ann, id))).toBe("bad-state");
    expect(getSession(id)!.source?.buildLabel).toBe("Factory_go");
    // unless the label is known to be gone on GitHub
    const s = clearSourceBuildLabel(ann, id, {}, true);
    expect(s.state).toBe("dropped");
    expect(s.source && "buildLabel" in s.source).toBe(false);
  });

  it("keeps the log line a running architect still needs", () => {
    const id = make();
    setArchitectRun(ann, id, "run-1");
    // one line fits before the slot for dropping, and the run needs it for its end
    padLog(id, LOG_LIMIT - 2);
    const before = getSession(id)!.log.length;
    const s = clearSourceBuildLabel(ann, id);
    expect(s.source && "buildLabel" in s.source).toBe(false);
    expect(s.log).toHaveLength(before);
  });
});
