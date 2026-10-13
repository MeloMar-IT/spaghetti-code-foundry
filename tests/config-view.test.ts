import { describe, expect, it } from "vitest";
import { ConfigSchema, parseConfigText } from "../src/config.js";
import { configView, storedConfigProblem, withStoredWebhook } from "../src/server/config-view.js";

const HOOK = "https://example.invalid/SECRET-HOOK";

describe("configView", () => {
  it("leaves the webhook out and says whether one is set", () => {
    const set = configView(ConfigSchema.parse({ notify: { slack_webhook: HOOK } }));
    expect(JSON.stringify(set)).not.toContain("SECRET-HOOK");
    expect(set.notify.slack_webhook_set).toBe(true);
    expect(configView(ConfigSchema.parse({})).notify.slack_webhook_set).toBe(false);
  });
});

describe("withStoredWebhook", () => {
  it("keeps, adds, removes and replaces", () => {
    expect(withStoredWebhook({ notify: { macos: true } }, HOOK)).toEqual({ notify: { macos: true, slack_webhook: HOOK } });
    expect(withStoredWebhook({ concurrency: 2 }, HOOK)).toEqual({ concurrency: 2, notify: { slack_webhook: HOOK } });
    expect(withStoredWebhook({ notify: { slack_webhook: null } }, HOOK)).toEqual({ notify: {} });
    expect(withStoredWebhook({ notify: { slack_webhook: "https://new.test/x" } }, HOOK)).toEqual({ notify: { slack_webhook: "https://new.test/x" } });
    expect(withStoredWebhook({ concurrency: 2 }, undefined)).toEqual({ concurrency: 2 });
  });

  it("drops the marker whatever it holds", () => {
    for (const m of [true, false, "x"]) expect(withStoredWebhook({ notify: { slack_webhook_set: m } }, undefined)).toEqual({ notify: {} });
  });

  it("leaves other bodies alone and does not change the input", () => {
    expect(withStoredWebhook("x", HOOK)).toBe("x");
    expect(withStoredWebhook({ notify: "x" }, HOOK)).toEqual({ notify: "x" });
    const body = { notify: { slack_webhook_set: true } };
    withStoredWebhook(body, HOOK);
    expect(body).toEqual({ notify: { slack_webhook_set: true } });
  });
});

describe("storedConfigProblem", () => {
  const err = (text: string) => {
    try {
      parseConfigText(text, "/x/config.yaml");
    } catch (e) {
      return e;
    }
    throw new Error("no error");
  };
  it("never quotes the file", () => {
    const m = storedConfigProblem(err(`notify:\n  slack_webhook: "${HOOK}\n`));
    expect(m).toContain("not valid YAML");
    expect(m).toMatch(/\(line \d+\)/);
    expect(m).not.toContain("SECRET-HOOK");
  });
  it("keeps the message of a settings error", () => expect(storedConfigProblem(err("concurrency: 0\n"))).toContain("concurrency"));
  it("uses fixed words for any other error", () => {
    expect(storedConfigProblem(new ReferenceError("x SECRET-HOOK"))).toBe("config.yaml is not valid YAML; fix the file by hand");
  });
});
