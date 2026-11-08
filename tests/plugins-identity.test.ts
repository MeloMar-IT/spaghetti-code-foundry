import { describe, expect, it } from "vitest";
import { hasIdentityProvider } from "../src/auth/identity.js";
import { loadPlugins, PluginLoadError, type PluginEntry } from "../src/plugins/load.js";

const entry = (module: string): PluginEntry => ({ module, options: {} });
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
};
const load = (registers: ((api: any) => unknown)[]) =>
  loadPlugins(registers.map((_, i) => entry(`/abs/p${i}.mjs`)), {
    blockedDirs: [],
    resolve: (s) => s,
    importModule: async (url) => ({ register: registers[Number(/p(\d+)\.mjs/.exec(url)![1])] }),
  });
const provider = { resolve: () => null };
const attempt = (fn: () => void) => {
  try {
    fn();
  } catch {
    /* the plugin catches the error on purpose */
  }
};

describe("api.identityProvider", () => {
  it("registers one provider, sync or async, and lists it", async () => {
    for (const resolve of [() => null, async () => null]) {
      const reg = await load([(api) => api.identityProvider({ resolve })]);
      expect(reg.plugins[0]!.registered).toEqual([{ point: "identity", name: "identityProvider" }]);
      expect(hasIdentityProvider()).toBe(true);
      reg.dispose!();
      expect(hasIdentityProvider()).toBe(false);
    }
  });
  it("stops the start for a second call by the same plugin, even when it catches the error", async () => {
    const err = await failure(
      load([
        (api) => {
          api.identityProvider(provider);
          attempt(() => api.identityProvider(provider));
        },
      ]),
    );
    expect(err).toBeInstanceOf(PluginLoadError);
    expect(err.message).toMatch(/^plugin "\/abs\/p0\.mjs" .*only be called once/);
    expect(hasIdentityProvider()).toBe(false);
  });
  it("stops the start for a second plugin, naming it", async () => {
    const err = await failure(load([(api) => api.identityProvider(provider), (api) => api.identityProvider(provider)]));
    expect(err).toBeInstanceOf(PluginLoadError);
    expect(err.message).toMatch(/^plugin "\/abs\/p1\.mjs" .*identity provider already/);
    expect(hasIdentityProvider()).toBe(false);
  });
  it("stops the start for a provider without resolve()", async () => {
    for (const bad of [undefined, {}, { resolve: 5 }]) {
      const err = await failure(load([(api) => attempt(() => api.identityProvider(bad))]));
      expect(err.message).toMatch(/^plugin "\/abs\/p0\.mjs" .*needs a resolve\(\) function/);
    }
    expect(hasIdentityProvider()).toBe(false);
  });
  it("stops the start for a call through a stored api, naming the plugin that owns it", async () => {
    let stored: any;
    const err = await failure(
      load([
        (api) => {
          stored = api;
        },
        () => stored.identityProvider(provider),
      ]),
    );
    expect(err).toBeInstanceOf(PluginLoadError);
    expect(err.message).toMatch(/^plugin "\/abs\/p0\.mjs" .*after register\(api\) ended/);
    expect(hasIdentityProvider()).toBe(false);
  });
  it("a call after the load has finished only adds a problem line", async () => {
    let stored: any;
    const reg = await load([(api) => void (stored = api)]);
    expect(() => stored.identityProvider(provider)).not.toThrow();
    expect(hasIdentityProvider()).toBe(false);
    expect(reg.problems).toEqual([{ plugin: "p0.mjs", reason: "identityProvider(provider) was called after register(api) ended; it is not used" }]);
    reg.dispose!();
  });
});
