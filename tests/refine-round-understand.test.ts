import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { SIMPLE_AVOID, simpleRules } from "../src/help/simple.js";
import { architectReason } from "../src/refinement/architect.js";
import { END_BAD_FORM } from "../src/refinement/store.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

let gh: ReturnType<typeof fakeGithub>;
beforeEach(() => {
  gh = fakeGithub();
});
afterEach(() => {
  delete process.env.FAKE_ROUND;
  gh.restore();
});

const run = (vars: Record<string, string> = {}) =>
  runFlow(loadFlow("refine-round", gh.tmp).flow, { task: "talk", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, vars: { github_repo: "acme/app", ...vars } });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const checked = (s: Parameters<typeof out>[0]) => JSON.parse(out(s, "check_round"));
const echoOf = (s: Parameters<typeof out>[0]) => JSON.parse(out(s, "round")).echo as string;

const PREFIX = "This is what I understood: ";
const draft = (over: Record<string, unknown> = {}) => ({
  title: "Export a report", who: "A team lead", what: "Download it.", why: "To share it.", criteria: ["It downloads a file."], outOfScope: "", dependsOn: [], summary: `${PREFIX}a lead wants a file.`, ...over,
});

describe("refine-round flow: ask=understand and words=simple", { timeout: 60_000 }, () => {
  it("writes one draft", async () => {
    const s = await run({ ask: "understand" });
    expect(s.status).toBe("succeeded");
    const c = checked(s);
    expect(c.drafts).toHaveLength(1);
    expect(c.drafts[0].summary.startsWith(PREFIX)).toBe(true);
  });

  it("passes three linked drafts", async () => {
    process.env.FAKE_ROUND = JSON.stringify({ drafts: [draft(), draft({ title: "Two", dependsOn: [1] }), draft({ title: "Three", dependsOn: [1, 2] })] });
    const s = await run({ ask: "understand" });
    expect(s.status).toBe("succeeded");
    expect(checked(s).drafts.map((d: { dependsOn: number[] }) => d.dependsOn)).toEqual([[], [1], [1, 2]]);
  });

  it("fails for six drafts at check_round", async () => {
    process.env.FAKE_ROUND = JSON.stringify({ drafts: Array.from({ length: 6 }, () => draft()) });
    const s = await run({ ask: "understand" });
    expect(s.status).toBe("failed");
    expect(s.reason).toBe('step "check_round" failed: exit code 1');
    expect(out(s, "check_round")).toBe("the answer has more than 5 drafts");
    expect(architectReason(s)).toBe(END_BAD_FORM);
  });

  it("gives the plain-words rules to a round only when asked", async () => {
    process.env.FAKE_ROUND = "ECHO";
    const simple = await run({ ask: "round", words: "simple" });
    expect(simple.status).toBe("succeeded");
    const prompt = echoOf(simple);
    expect(prompt).toMatch(/^The words: simple$/m);
    for (const line of simpleRules([]).slice(0, 3)) expect(prompt).toContain(line);
    expect(checked(simple).questions[0].text).toBe("Who will use this change?");
    const text = JSON.stringify(checked(simple).questions).toLowerCase();
    for (const w of SIMPLE_AVOID) expect(text).not.toContain(w);
    const plain = await run({ ask: "round", words: "" });
    expect(echoOf(plain)).toMatch(/^The words: $/m);
  });
});
