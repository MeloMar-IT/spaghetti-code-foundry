import { describe, expect, it } from "vitest";
import { ConfigSchema, parseConfigText } from "../src/config.js";
import { ZodError } from "zod";
import { configIssues, configView, storedConfigProblem, withStoredPlugins, withStoredServices, withStoredWebhook } from "../src/server/config-view.js";

describe("configIssues", () => {
  const issuesOf = (input: unknown) => {
    const r = ConfigSchema.safeParse(input);
    return r.success ? undefined : configIssues(r.error);
  };
  it("gives dotted paths and the rule's message", () => {
    expect(issuesOf({ skills: { selection: { include: ["x"], exclude: ["x"] } } })).toContainEqual({ path: "skills.selection.include.0", message: '"x" is also in exclude' });
    expect(issuesOf({ skills: { roots: ["/a", "/b/.claude"] } })).toContainEqual({ path: "skills.roots.1", message: expect.stringContaining("personal agent folders are never scanned") });
    expect(issuesOf({ skills: { catalogue: { max_candidates: 1, include: ["a", "b"] } } })?.map((i) => i.path)).toContain("skills.catalogue.include");
  });
  it("is undefined for anything but a ZodError", () => {
    expect(configIssues(new Error("x"))).toBeUndefined();
    expect(configIssues("x")).toBeUndefined();
    expect(configIssues(undefined)).toBeUndefined();
  });
  it("lists at most 50", () => {
    const e = new ZodError(Array.from({ length: 60 }, (_, i) => ({ code: "custom" as const, path: ["a", i], message: "m", input: undefined })));
    const out = configIssues(e)!;
    expect(out).toHaveLength(50);
    expect(out[0].path).toBe("a.0");
  });
});

const HOOK = "https://example.invalid/SECRET-HOOK";

describe("configView", () => {
  it("leaves the webhook out and says whether one is set", () => {
    const set = configView(ConfigSchema.parse({ notify: { slack_webhook: HOOK } }));
    expect(JSON.stringify(set)).not.toContain("SECRET-HOOK");
    expect(set.notify.slack_webhook_set).toBe(true);
    expect(configView(ConfigSchema.parse({})).notify.slack_webhook_set).toBe(false);
  });
});

describe("plugins in the settings", () => {
  const plugins = [{ module: "acme", options: { token: "SECRET-OPT" } }];
  it("configView leaves them out, options included", () => {
    const v = configView(ConfigSchema.parse({ plugins }));
    expect("plugins" in v).toBe(false);
    expect(JSON.stringify(v)).not.toContain("SECRET-OPT");
  });
  it("withStoredPlugins puts the stored list back without changing the body", () => {
    const body = { concurrency: 2 };
    expect(withStoredPlugins(body, plugins)).toEqual({ concurrency: 2, plugins });
    expect(body).toEqual({ concurrency: 2 });
  });
  it("returns a non-object body and an empty list unchanged", () => {
    expect(withStoredPlugins("x", plugins)).toBe("x");
    const body = { concurrency: 2 };
    expect(withStoredPlugins(body, [])).toBe(body);
  });
});

describe("services in the settings (#867)", () => {
  const services = [{ name: "bot", command: "/usr/bin/true", env: { API_KEY: "SECRET-ENV" }, scope: ["GET health"] }];
  it("configView leaves them out, env included", () => {
    const v = configView(ConfigSchema.parse({ services }));
    expect("services" in v).toBe(false);
    expect(JSON.stringify(v)).not.toContain("SECRET-ENV");
  });
  it("withStoredServices puts the stored list back without changing the body", () => {
    const stored = ConfigSchema.parse({ services }).services;
    const body = { concurrency: 2 };
    expect(withStoredServices(body, stored)).toEqual({ concurrency: 2, services: stored });
    expect(body).toEqual({ concurrency: 2 });
    expect(withStoredServices("x", stored)).toBe("x");
    expect(withStoredServices(body, [])).toBe(body);
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
