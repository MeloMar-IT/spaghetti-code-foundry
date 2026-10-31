import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";

// The coding turn of the issue flows has 60 minutes; the other steps keep the flow default.
describe("the time limit of the coding turn", () => {
  for (const file of ["flows/issue-gitflow.yaml", "flows/issue-code-daily.yaml", "tests/fixtures/flows/issue-deliver.yaml"]) {
    it(`is 60 minutes in ${file}`, () => {
      const flow = parseFlow(readFileSync(file, "utf8"), file);
      expect(flow.steps.find((s) => s.id === "implement")?.timeout_sec).toBe(3600);
      expect(flow.defaults?.timeout_sec).toBe(2400);
    });
  }
});
