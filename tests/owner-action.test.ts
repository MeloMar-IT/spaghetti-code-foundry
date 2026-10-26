import { describe, expect, it } from "vitest";
import { readQuestions } from "../tools/decide-questions.mjs";
import { actionText, contentsPath, filesToCheck, openOwnerActions, ownerActions, OWNER_FILE_MARK, questionKinds, safeRepoPath } from "../src/queue/owner-action.js";

const q = (kind: string, extra = "") => `**Q1. Add the file**\n${kind}\n${extra}**Recommendation:** none\n`;
const bot = (body: string, createdAt = "2026-01-01T00:00:00Z") => ({ author: { login: "bot" }, body: `${body}\n<!-- claude-factory run=r1 -->`, createdAt });
const human = (body: string) => ({ author: { login: "marcel" }, body, createdAt: "2026-01-01T01:00:00Z" });
const first = (body: string) => ownerActions(body)[0];

describe("owner_action questions", () => {
  it.each(["**Kind:** owner_action", "**Kind:** owner action", "**Kind:** Owner-Action", "**Kind**: owner_action", "**Kind:** `owner_action`"])("reads the kind %s", (k) => {
    expect(ownerActions(q(k))).toHaveLength(1);
  });

  it("counts the placeholder line and an unknown kind as product", () => {
    expect(ownerActions(q("**Kind:** technical | product | policy | owner_action"))).toHaveLength(0);
    expect(ownerActions(q("**Kind:** something"))).toHaveLength(0);
    expect(ownerActions("**Q1. No kind**\ntext")).toHaveLength(0);
  });

  it("reads the kinds the way tools/decide-questions.mjs does", () => {
    const bodies = [
      q("**Kind:** owner_action"), q("**Kind:** technical"), q("**Kind:** policy."), q("**Kind:** Owner Action"), q("**Kind:** a | b"),
      `${q("**Kind:** owner_action")}\n**Q2. Two**\n**Kind:** technical\nx\n**Q3. Three**\ntext`,
      `${q("**Kind:** product")}\n**Decided by the Foundry**\n**Q9. Late**\n**Kind:** owner_action\n`,
      "QUESTIONS: 2\n**Q1. a**\n**Kind**: `policy`\n",
    ];
    for (const b of bodies) expect(questionKinds(b).map((k) => k.kind)).toEqual(readQuestions(b).questions.map((k: { kind: string }) => k.kind));
  });

  it("ignores questions after the decided heading", () => {
    expect(ownerActions(`${q("**Kind:** product")}\n**Decided by the Foundry**\n**Q9. Late**\n**Kind:** owner_action\n`)).toHaveLength(0);
  });

  it.each([
    ["**Needs:** file `config/app.yaml`", "config/app.yaml"],
    ["**Needs:** file config/app.yaml", "config/app.yaml"],
    ["**Needs:** file config/app.yaml.", "config/app.yaml"],
    ["**Needs:** file `config/v1.`", "config/v1."],
    ["**Needs**: file docs/a b.md".replace("a b", "a"), "docs/a.md"],
  ])("reads the file of %s", (needs, path) => {
    expect(first(q("**Kind:** owner_action", `${needs}\n`))?.file).toBe(path);
  });

  it.each(["file ../x", "file /etc/passwd", "file a//b", "file a b", "file x?ref=main", "file %2e%2e/x", "file .git/config", "file -x", `file ${"a".repeat(301)}`, "account"])("rejects %s", (needs) => {
    expect(first(q("**Kind:** owner_action", `**Needs:** ${needs}\n`))?.file).toBeUndefined();
  });

  it("takes no file from two Needs lines", () => {
    expect(first(q("**Kind:** owner_action", "**Needs:** file a\n**Needs:** file b\n"))?.file).toBeUndefined();
  });

  it("finds the open owner actions of the newest Foundry comment", () => {
    const ask = bot(q("**Kind:** owner_action"), "2026-01-02T00:00:00Z");
    const status = { author: { login: "bot" }, body: "x\n<!-- claude-factory status -->", createdAt: "2026-01-03T00:00:00Z" };
    expect(openOwnerActions([ask, status])?.since).toBe("2026-01-02T00:00:00Z");
    expect(openOwnerActions([ask, status])?.actions[0]?.action).toBe("Add the file");
    expect(openOwnerActions([ask, human("done")])).toBeUndefined();
    expect(openOwnerActions([bot(q("**Kind:** owner_action")), bot(q("**Kind:** product"))])).toBeUndefined();
  });

  it("keeps the question open behind a file note", () => {
    const note = bot(`**Nothing needed from you**\n\n${OWNER_FILE_MARK}`);
    expect(openOwnerActions([bot(q("**Kind:** owner_action")), note])).toBeDefined();
  });

  it("checks files only when every open question is an owner action with a file", () => {
    const two = (b: string) => openOwnerActions([bot(b)])!;
    const a = q("**Kind:** owner_action", "**Needs:** file a\n");
    const b = q("**Kind:** owner_action", "**Needs:** file b\n").replace("Q1", "Q2");
    expect(filesToCheck(two(`${a}\n${b}`))).toEqual(["a", "b"]);
    expect(filesToCheck(two(`${a}\n${q("**Kind:** product").replace("Q1", "Q2")}`))).toEqual([]);
    expect(filesToCheck(two(`${a}\n${q("**Kind:** owner_action").replace("Q1", "Q2")}`))).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => q("**Kind:** owner_action", `**Needs:** file f${i}\n`).replace("Q1", `Q${i + 1}`)).join("\n");
    expect(filesToCheck(two(many))).toEqual([]);
  });

  it("cleans the action text", () => {
    expect(actionText("Commit <!-- claude-factory run=x --> now")).not.toMatch(/[<>]/);
    expect(actionText("a\n\n b\t c")).toBe("a b c");
    expect(actionText("x".repeat(500)).length).toBe(200);
  });

  it("builds the contents path", () => {
    expect(contentsPath("acme/app", "a/b@c+d.txt", "feature/x")).toBe("repos/acme/app/contents/a/b%40c%2Bd.txt?ref=feature%2Fx");
    expect(contentsPath("acme/app", "a")).toBe("repos/acme/app/contents/a");
    expect(safeRepoPath("src/a.ts")).toBe("src/a.ts");
  });
});
