import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { dataHome } from "../src/auth/store.js";
import { ConfigSchema } from "../src/config.js";
import { approvalsPath, readApprovals, updateSourceApprovals } from "../src/skills/approvals.js";
import { approveAutoRelease, autoApproveSettings, type AutoApproveInput } from "../src/skills/auto-approve.js";
import type { ApprovedRelease } from "../src/skills/release.js";
import { approvalSignatureState, rawPublicKey } from "../src/skills/release-signature.js";
import { parseSources, type SkillLibrarySource } from "../src/skills/sources.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

// approveAutoRelease against the data folder of the test run (tests/setup.ts makes it a temporary folder).

const REPO_KEY = "github.com/acme/skills";
let base: string;
let n = 0;
let priv: KeyObject;
let keyFile: string;

const clean = () => {
  const home = dataHome();
  for (const f of ["skill-releases", "skill-approvals.json", "skill-approvals.lock", "audit.jsonl"]) rmSync(join(home, f), { recursive: true, force: true });
};
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "autoappr-"));
  clean();
  autoApproveSettings.beforeAuditWrite = undefined;
  priv = generateKeyPairSync("ed25519").privateKey;
  keyFile = join(base, "auto.pem");
  writeFileSync(keyFile, priv.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clean();
});

function source(over: Record<string, unknown> = {}, auto = true): SkillLibrarySource {
  const r = parseSources({
    schema: 1,
    sources: [
      {
        id: "s1",
        repository: "https://github.com/acme/skills",
        status: "enabled",
        ref: { track: "main", approved: "0123456789abcdef0123456789abcdef01234567" },
        paths: ["skills"],
        adapter: "agent-skills",
        trust: "first-party",
        licence: { allow: ["MIT"] },
        update: { cadence: "weekly", ...(auto ? { auto: true } : {}) },
        owner: "@octocat",
        ...over,
      },
    ],
  });
  return r.manifest!.sources[0]!;
}

function publish(version: string, opts: Parameters<typeof writeV2Release>[1] = {}, skills = ["alpha"]): ApprovedRelease {
  const scratch = join(base, `scratch-${n++}`);
  for (const skill of skills) {
    const d = join(scratch, skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${skill}\ndescription: A test skill called ${skill}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${skill}\nversion: ${version}\n`);
  }
  const { approved } = writeV2Release(scratch, { catalogue: "acme", version, repositoryKey: REPO_KEY, trust: "first-party", ...opts });
  const dest = join(dataHome(), "skill-releases", "acme", version);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(scratch, dest, { recursive: true });
  return approved;
}

const releases = (o: { keys?: boolean; auto_key?: boolean; approved?: ApprovedRelease[]; file?: string } = {}) =>
  ConfigSchema.parse({
    skills: {
      roots: [],
      releases: {
        approved: o.approved ?? [],
        keys: o.keys === false ? [] : [{ id: "k1", ed25519: rawPublicKey(priv) }],
        ...(o.auto_key === false ? {} : { auto_key: { id: "k1", file: o.file ?? keyFile } }),
      },
    },
  }).skills.releases;
const input = (version = "1.0.0", sourceId = "s1"): AutoApproveInput => ({ sourceId, catalogue: "acme", version });
const auditLines = (): { action: string; result: string; target?: string; detail?: string }[] =>
  existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const stored = () => {
  const r = readApprovals();
  return r.state === "ok" ? r.sources : {};
};

describe("approveAutoRelease", () => {
  it("writes a signed entry and one audit line without key material", () => {
    const a = publish("1.0.0");
    const r = approveAutoRelease(input(), { releases: releases(), sources: [source()] });
    expect(r.state).toBe("approved");
    const e = stored().s1!.releases[0]!;
    expect(e).toMatchObject({ catalogue: "acme", version: "1.0.0", digest: a.digest, key: "k1" });
    expect(approvalSignatureState(e, releases().keys).state).toBe("signed");
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: "skill-auto-approve", result: "ok", target: "acme@1.0.0" });
    const text = readFileSync(auditPath(), "utf8");
    expect(text).not.toContain(e.signature!);
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(keyFile);
  });

  it("with keys empty writes an unsigned entry", () => {
    publish("1.0.0");
    const r = approveAutoRelease(input(), { releases: releases({ keys: false, auto_key: false }), sources: [source()] });
    expect(r.state).toBe("approved");
    expect(stored().s1!.releases[0]!.key).toBeUndefined();
  });

  it("repeat call is unchanged and the file stays the same", () => {
    publish("1.0.0");
    const o = { releases: releases(), sources: [source()] };
    approveAutoRelease(input(), o);
    const before = readFileSync(approvalsPath(), "utf8");
    expect(approveAutoRelease(input(), o).state).toBe("unchanged");
    expect(readFileSync(approvalsPath(), "utf8")).toBe(before);
    expect(auditLines()).toHaveLength(1);
  });

  describe("refuses, writes nothing to the store and one failed audit line", () => {
    const refused = (r: ReturnType<typeof approveAutoRelease>, reason?: string) => {
      expect(r.state).toBe("refused");
      if (reason && r.state === "refused") expect(r.reason).toContain(reason);
      expect(existsSync(approvalsPath())).toBe(false);
      const lines = auditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: "skill-auto-approve", result: "failed" });
      expect(readFileSync(auditPath(), "utf8")).not.toContain(keyFile);
    };
    it("keys without auto_key", () => {
      publish("1.0.0");
      refused(approveAutoRelease(input(), { releases: releases({ auto_key: false }), sources: [source()] }), "auto_key");
    });
    it("a missing key file", () => {
      publish("1.0.0");
      refused(approveAutoRelease(input(), { releases: releases({ file: join(base, "nope.pem") }), sources: [source()] }), "cannot be read");
    });
    it("a key file with mode 0644", () => {
      publish("1.0.0");
      chmodSync(keyFile, 0o644);
      refused(approveAutoRelease(input(), { releases: releases(), sources: [source()] }), "group or others");
    });
    it("a key that does not match keys[id]", () => {
      publish("1.0.0");
      const other = generateKeyPairSync("ed25519").privateKey;
      const rel = ConfigSchema.parse({ skills: { releases: { keys: [{ id: "k1", ed25519: rawPublicKey(other) }], auto_key: { id: "k1", file: keyFile } } } }).skills.releases;
      refused(approveAutoRelease(input(), { releases: rel, sources: [source()] }), "does not hold the key");
    });
    it("a source that is not auto, community, disabled or unknown", () => {
      publish("1.0.0");
      const rel = releases();
      refused(approveAutoRelease(input(), { releases: rel, sources: [source({}, false)] }), "update.auto");
      rmSync(auditPath());
      refused(approveAutoRelease(input(), { releases: rel, sources: [{ ...source(), trust: "community" }] }));
      rmSync(auditPath());
      refused(approveAutoRelease(input(), { releases: rel, sources: [{ ...source(), status: "disabled" }] }));
      rmSync(auditPath());
      refused(approveAutoRelease(input("1.0.0", "other"), { releases: rel, sources: [source()] }));
    });
    it("a release that is not in the store", () => {
      refused(approveAutoRelease(input(), { releases: releases(), sources: [source()] }), "not in the release store");
    });
    it("content from another repository, community trust, or a mix", () => {
      const rel = releases();
      const cases: Parameters<typeof writeV2Release>[1][] = [
        { repositoryKey: "github.com/other/skills" },
        { trust: "community" },
        { perSkill: { beta: { repositoryKey: "github.com/other/skills" } } },
      ];
      cases.forEach((c, i) => {
        clean();
        publish("1.0.0", c, ["alpha", "beta"]);
        refused(approveAutoRelease(input(), { releases: rel, sources: [source()] }), "not from source s1");
        expect(i).toBeGreaterThanOrEqual(0);
      });
    });
    it("a digest conflict with the config", () => {
      const a = publish("1.0.0");
      refused(approveAutoRelease(input(), { releases: releases({ approved: [{ ...a, digest: `sha256:${"f".repeat(64)}` }] }), sources: [source()] }), "another digest");
    });
  });

  it("a release already approved in the config is unchanged, with no file", () => {
    const a = publish("1.0.0");
    const r = approveAutoRelease(input(), { releases: releases({ approved: [a] }), sources: [source()] });
    expect(r.state).toBe("unchanged");
    expect(existsSync(approvalsPath())).toBe(false);
  });

  it("refuses when the store is at its size limit and keeps the old bytes", () => {
    publish("1.0.0");
    updateSourceApprovals(() => ({ s1: { repositoryKey: REPO_KEY, releases: Array.from({ length: 100 }, (_, i) => ({ catalogue: "other", version: `1.0.${i}`, digest: `sha256:${"a".repeat(64)}`, at: "2026-01-01T00:00:00Z" })) } }));
    const before = readFileSync(approvalsPath(), "utf8");
    const r = approveAutoRelease(input(), { releases: releases(), sources: [source()] });
    expect(r.state).toBe("refused");
    expect(readFileSync(approvalsPath(), "utf8")).toBe(before);
  });

  it("refuses when the audit log cannot be opened, and changes nothing", () => {
    publish("1.0.0");
    mkdirSync(auditPath());
    const r = approveAutoRelease(input(), { releases: releases(), sources: [source()] });
    expect(r.state).toBe("refused");
    expect(existsSync(approvalsPath())).toBe(false);
  });

  it("keeps the entry and says so when the audit line cannot be written after the write", () => {
    publish("1.0.0");
    autoApproveSettings.beforeAuditWrite = () => {
      throw new Error("disk full");
    };
    const log: string[] = [];
    const r = approveAutoRelease(input(), { releases: releases(), sources: [source()], log: (l) => log.push(l) });
    expect(r.state).toBe("approved");
    expect(r.notes).toContain("the approval is not in the audit log");
    expect(log).toEqual(["audit: audit.jsonl not-written (skill-auto-approve)"]);
    expect(stored().s1!.releases).toHaveLength(1);
  });

  it("replaces an unsigned entry when signing is turned on, and a signed one when the key rotates", () => {
    publish("1.0.0");
    expect(approveAutoRelease(input(), { releases: releases({ keys: false, auto_key: false }), sources: [source()] }).state).toBe("approved");
    expect(stored().s1!.releases[0]!.key).toBeUndefined();

    const signed = releases();
    expect(approveAutoRelease(input(), { releases: signed, sources: [source()] }).state).toBe("approved");
    expect(stored().s1!.releases).toHaveLength(1);
    expect(approvalSignatureState(stored().s1!.releases[0]!, signed.keys).state).toBe("signed");

    const priv2 = generateKeyPairSync("ed25519").privateKey;
    const keyFile2 = join(base, "auto2.pem");
    writeFileSync(keyFile2, priv2.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const rot = ConfigSchema.parse({
      skills: {
        roots: [],
        releases: { keys: [{ id: "k1", ed25519: rawPublicKey(priv) }, { id: "k2", ed25519: rawPublicKey(priv2) }], auto_key: { id: "k2", file: keyFile2 } },
      },
    }).skills.releases;
    expect(approveAutoRelease(input(), { releases: rot, sources: [source()] }).state).toBe("approved");
    const e = stored().s1!.releases;
    expect(e).toHaveLength(1);
    expect(e[0]!.key).toBe("k2");
    expect(approvalSignatureState(e[0]!, rot.keys).state).toBe("signed");
    expect(auditLines().map((l) => l.result)).toEqual(["ok", "ok", "ok"]);

    expect(approveAutoRelease(input(), { releases: rot, sources: [source()] }).state).toBe("unchanged");
    expect(auditLines()).toHaveLength(3);
  });

  it("refuses a new source when the store already holds 200 sources, and keeps the file", () => {
    publish("1.0.0");
    updateSourceApprovals(() => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`x${i}`, { repositoryKey: REPO_KEY, releases: [] }])));
    const before = readFileSync(approvalsPath(), "utf8");
    const r = approveAutoRelease(input(), { releases: releases(), sources: [source()] });
    expect(r.state).toBe("refused");
    expect(r.state === "refused" && r.reason).toContain("too-large");
    expect(readFileSync(approvalsPath(), "utf8")).toBe(before);
    expect(auditLines()).toMatchObject([{ action: "skill-auto-approve", result: "failed" }]);
  });

  it("never deletes a release", () => {
    for (let i = 0; i < 7; i++) {
      publish(`1.0.${i}`);
      expect(approveAutoRelease(input(`1.0.${i}`), { releases: releases(), sources: [source()] }).state).toBe("approved");
    }
    expect(readdirSync(join(dataHome(), "skill-releases", "acme"))).toHaveLength(7);
    expect(stored().s1!.releases).toHaveLength(7);
  });
});
