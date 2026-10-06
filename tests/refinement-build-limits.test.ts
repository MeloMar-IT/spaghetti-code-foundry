import { describe, expect, it } from "vitest";
import { WatcherSchema, type WatcherConfig } from "../src/config.js";
import { buildLimitsOf, type LoadFlowVars } from "../src/refinement/build-limits.js";

const GITFLOW = { max_files: "15", max_code_lines: "800", review_plan_label: "Factory_review_plan" };
const flows: Record<string, Record<string, string>> = { "issue-gitflow": GITFLOW, "issue-deliver": { review_plan_label: "Deliver_review" }, "other-flow": { max_files: "5", max_code_lines: "50" } };
const load: LoadFlowVars = (n) => flows[n];
const w = (over: Record<string, unknown> = {}, extra: { ownerId?: string; repoId?: string } = {}): WatcherConfig =>
  ({ ...WatcherSchema.parse({ id: "w1", github_repo: "acme/app", ...over }), ...extra }) as WatcherConfig;

describe("buildLimitsOf", () => {
  it("gives {} for no watcher, another repository or a disabled watcher", () => {
    expect(buildLimitsOf("acme/app", [], load)).toEqual({});
    expect(buildLimitsOf("acme/app", [w({ github_repo: "acme/other" })], load)).toEqual({});
    expect(buildLimitsOf("acme/app", [w({ enabled: false })], load)).toEqual({});
  });

  it("takes the default flow of the source", () => {
    const asked: string[] = [];
    const r = buildLimitsOf("acme/app", [w()], (n) => (asked.push(n), flows[n]));
    expect(asked).toEqual(["issue-gitflow"]);
    expect(r).toEqual({ flow: "issue-gitflow", maxFiles: 15, maxCodeLines: 800, reviewLabel: "Factory_review_plan" });
  });

  it("lets the watcher vars win, and drops an empty label", () => {
    expect(buildLimitsOf("acme/app", [w({ vars: { max_files: "30" } })], load).maxFiles).toBe(30);
    expect(buildLimitsOf("acme/app", [w({ vars: { review_plan_label: " " } })], load)).not.toHaveProperty("reviewLabel");
  });

  it("matches the repository name in another case and with .git", () => {
    expect(buildLimitsOf("Acme/App.git", [w()], load).maxFiles).toBe(15);
  });

  it("skips a flow without limits and takes the next watcher with limits", () => {
    const r = buildLimitsOf("acme/app", [w({ flow: "issue-deliver" }), w({ id: "w2", flow: "other-flow" })], load);
    expect(r).toEqual({ flow: "other-flow", maxFiles: 5, maxCodeLines: 50 });
  });

  it("falls back to the flow and label of the first loadable flow when no watcher has limits", () => {
    expect(buildLimitsOf("acme/app", [w({ flow: "missing" }), w({ id: "w2", flow: "issue-deliver" })], load)).toEqual({ flow: "issue-deliver", reviewLabel: "Deliver_review" });
  });

  it("treats a non-numeric limit as no limits", () => {
    expect(buildLimitsOf("acme/app", [w({ vars: { max_files: "many" } })], load)).toEqual({ flow: "issue-gitflow", reviewLabel: "Factory_review_plan" });
  });

  it("skips a missing flow and a source without a default flow", () => {
    expect(buildLimitsOf("acme/app", [w({ flow: "missing" })], load)).toEqual({});
    expect(buildLimitsOf("acme/app", [w({ source: "pr-feedback" })], load)).toEqual({});
  });

  describe("order", () => {
    const theirs = w({ id: "t", vars: { max_files: "1" } }, { ownerId: "bob", repoId: "r2" });
    const config = w({ id: "c", vars: { max_files: "2" } });
    const mine = w({ id: "m", vars: { max_files: "3" } }, { ownerId: "ann", repoId: "r1" });
    const mine2 = w({ id: "m2", vars: { max_files: "4" } }, { ownerId: "ann", repoId: "r1" });
    it("takes the own stored watcher, then config.yaml, then any other", () => {
      expect(buildLimitsOf("acme/app", [theirs, config, mine], load, "ann").maxFiles).toBe(3);
      expect(buildLimitsOf("acme/app", [theirs, config], load, "ann").maxFiles).toBe(2);
      expect(buildLimitsOf("acme/app", [theirs], load, "ann").maxFiles).toBe(1);
    });
    it("takes the first of two own watchers", () => {
      expect(buildLimitsOf("acme/app", [mine, mine2], load, "ann").maxFiles).toBe(3);
    });
  });
});
