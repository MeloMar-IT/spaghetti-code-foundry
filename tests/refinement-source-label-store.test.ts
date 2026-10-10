import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOG_LIMIT,
  RefinementError,
  addDraft,
  clearSourceBuildLabel,
  createSessionFromIssue,
  dropSession,
  getSession,
  openSessionOfIssue,
  refinementsPath,
  removeDraft,
  restoreSession,
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

const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const T = { repoOk: () => true };
const pub = (n: number) => ({ issue: n, url: `https://github.com/acme/app/issues/${n}`, at: "2026-01-02T00:00:00.000Z" });

/** A session of issue 7 whose first draft (the mark) is split into two parts; `parts` of them are on GitHub. */
function splitSession(published: 0 | 1 | 2 = 0) {
  const id = make();
  for (let i = 0; i < 3; i++) addDraft(ann, id, T);
  const ids = getSession(id)!.drafts.map((d) => d.id) as [string, string, string];
  edit((f) => {
    const s = f.sessions.find((x: any) => x.id === id);
    s.source.draft = ids[0];
    s.drafts[0].splitInto = [ids[1], ids[2]];
    s.drafts[1].part = { of: ids[0] };
    s.drafts[2].part = { of: ids[0] };
    for (let i = 0; i < published; i++) s.drafts[i + 1].published = pub(40 + i);
    if (published === 2) s.state = "published";
  });
  return { id, ids };
}

describe("a published session that is due", () => {
  it("is found by openSessionOfIssue; a replaced or a dropped one is not", () => {
    const { id } = splitSession(2);
    expect(openSessionOfIssue(ANN, "acme/app", 7)?.id).toBe(id);
    edit((f) => (f.sessions.find((x: any) => x.id === id).source.replacedBy = [40, 41]));
    expect(openSessionOfIssue(ANN, "acme/app", 7)).toBeUndefined();
    edit((f) => delete f.sessions.find((x: any) => x.id === id).source.replacedBy);
    expect(openSessionOfIssue(ANN, "acme/app", 7)?.id).toBe(id);
    dropSession(ann, id);
    expect(openSessionOfIssue(ANN, "acme/app", 7)).toBeUndefined();
  });

  it("stops a dropped session of the issue from being restored, and a dropped one blocks nothing", () => {
    const { id } = splitSession(2);
    dropSession(ann, id);
    // a dropped session blocks nothing: the issue can be imported again
    const other = make();
    expect(code(() => restoreSession(ann, id))).toBe("duplicate");
    dropSession(ann, other);
    expect(restoreSession(ann, id).state).toBe("published");
    // another session that is due blocks it too
    dropSession(ann, id);
    const due = splitSession(2).id;
    expect(code(() => restoreSession(ann, id))).toBe("duplicate");
    expect(getSession(due)!.state).toBe("published");
  });
});

describe("removing the draft that stands for a split issue", () => {
  it("is allowed before a part is on GitHub and refused after", () => {
    const before = splitSession(0);
    expect(removeDraft(ann, before.id, before.ids[0], T).drafts.some((d) => d.id === before.ids[0])).toBe(false);
    dropSession(ann, before.id);
    const after = splitSession(1);
    expect(code(() => removeDraft(ann, after.id, after.ids[0], T))).toBe("bad-state");
    expect(getSession(after.id)!.drafts.some((d) => d.id === after.ids[0])).toBe(true);
  });
});

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
