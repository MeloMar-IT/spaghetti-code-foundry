import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rc: any; // ui/repo-connect.js, loaded first: the other order of the import cycle with ui/repos.js
let repos: any;
beforeAll(async () => {
  restore = installFakeDom();
  rc = await import("../ui/repo-connect.js" as string);
  repos = await import("../ui/repos.js" as string);
});
afterAll(() => restore());

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const SSH = "git@github.com:o/a.git";
const APP_URL = "https://github.com/apps/foundry-app/installations/new";
const ALL = { methods: ["github-token", "https-token", "ssh-deploy-key", "github-app", "none"], githubApp: { available: true, installUrl: APP_URL } };

type Answer = { status: number; error: string; apply?: boolean } | "throw";
let list: any[];
let sent: { method: string; url: string; body: any }[];
let queued: Record<string, Answer[]>;
let holds: Record<string, (a?: Answer) => void>;
let holdKeys: Set<string>;
let testResult: any;
let n = 0;
const connection = (ok: boolean) => ({
  at: new Date().toISOString(),
  ok,
  checks: ok
    ? [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }, { check: "push", ok: true, code: "ok", message: "Write access works. Nothing was pushed." }]
    : [{ check: "clone", ok: false, code: "bad-token", message: "The host did not accept the token." }, { check: "push", ok: false, skipped: true, code: "skipped", message: "Not checked." }],
});
const realFetch = globalThis.fetch;

/** The record after a sign-in change, as the server stores it (the old status is gone). */
const apply = (rec: any, body: any) => {
  const { connection: _gone, ...old } = rec;
  const next: any = { ...old, ...(body.url ? { url: body.url } : {}), method: body.method };
  if (body.method === "https-token") next.username = body.username;
  else delete next.username;
  if (body.method === "ssh-deploy-key") next.publicKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(++n).padStart(43, "k")}`;
  else delete next.publicKey;
  return next;
};

beforeEach(() => {
  list = [];
  sent = [];
  queued = {};
  holds = {};
  holdKeys = new Set();
  testResult = connection(true);
  n = 0;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = `${init.method} ${url}`;
    sent.push({ method: init.method, url, body });
    let answer = queued[key]?.shift();
    if (holdKeys.delete(key)) answer = await new Promise<Answer | undefined>((r) => (holds[key] = r));
    if (answer === "throw" || (answer && answer.apply)) {
      if (typeof answer === "object" && answer.apply) {
        const at = list.findIndex((r) => `/api/repos/${r.id}/auth` === url);
        list[at] = apply(list[at], body);
      }
      if (answer === "throw" || answer.status === 0) throw new TypeError("fetch failed");
    }
    if (answer && answer !== "throw") return reply({ error: answer.error }, answer.status);
    if (key === "GET /api/repos") return reply([...list]);
    if (init.method === "POST" && url.endsWith("/test")) return reply(testResult);
    if (key === "POST /api/repos") {
      const rec = {
        id: `id${list.length + 1}`,
        url: body.url,
        method: body.method,
        ...(body.username ? { username: body.username } : {}),
        ...(body.method === "ssh-deploy-key" ? { publicKey: apply({}, body).publicKey } : {}),
      };
      list.push(rec);
      return reply(rec, 201);
    }
    if (init.method === "PUT") {
      const at = list.findIndex((r) => `/api/repos/${r.id}/auth` === url);
      list[at] = apply(list[at], body);
      return reply(list[at]);
    }
    return reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (name: string) => walk(root()).find((e) => e.attrs.name === name);
const button = (text: string) => walk(root()).find((e) => e.tag === "button" && e.textContent === text);
const press = (text: string) => {
  const b = button(text);
  expect(b, `button ${text}`).toBeDefined();
  b!.click();
};
const type = (name: string, value: string) => {
  expect(field(name), `field ${name}`).toBeDefined();
  field(name)!.value = value;
};
const choose = (id: string) => {
  const s = field("method")!;
  s.value = id;
  s.fire("change");
};
const headings = () => walk(root()).filter((e) => e.tag === "h3").map((e) => e.textContent);
const errors = () => walk(root()).filter((e) => (e.attrs.class ?? "").split(" ").includes("bad")).map((e) => e.textContent);
const key = (k: string) => (document as any).listeners.keydown.forEach((fn: any) => fn({ key: k, shiftKey: false, preventDefault: () => {} }));
const posts = () => sent.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.url}`);
const saves = () => sent.filter((s) => s.method !== "GET" && !s.url.endsWith("/test"));
const tick = (on = true) => {
  const c = field("replace")!;
  c.checked = on;
  c.fire("change");
};
const open = (o: object = {}) => repos.repoDialog({ admin: true, options: ALL, ...o }) as Promise<any>;
const hold = (k: string) => holdKeys.add(k);
const release = (k: string, a?: Answer) => holds[k]!(a);
/** Add repository up to the save; `fields` are typed on the details step. */
const add = async (url: string, method?: string, fields: Record<string, string> = {}, o: object = {}) => {
  const done = open(o);
  type("url", url);
  press("Next");
  if (method) choose(method);
  for (const [k, v] of Object.entries(fields)) type(k, v);
  press("Add repository");
  await flush();
  // wrapped: an async function must not wait for the dialog to close
  return { done };
};
const httpsRec = (over: object = {}) => ({ id: "id1", url: "https://git.example.com/a/b", method: "https-token", username: "ann", ...over });
const change = (rec: any, o: object = {}) => {
  list = [rec];
  return open({ repo: rec, ...o });
};
/** Continue, tick the box, Replace the sign-in. */
const replaceSignIn = async () => {
  press("Continue");
  tick();
  press("Replace the sign-in");
  await flush();
};

describe("the steps", () => {
  it("opens on the address with only the address and Next", () => {
    void open();
    expect(headings()).toEqual(["1. Address"]);
    expect(field("url")).toBeDefined();
    expect(button("Next")).toBeDefined();
    expect(field("method")).toBeUndefined();
    expect(field("token")).toBeUndefined();
  });

  it("an empty address stays on the first step and marks the field", () => {
    void open();
    press("Next");
    expect(errors()).toEqual(["Fill in the repository URL."]);
    expect(field("url")!.attrs["aria-invalid"]).toBe("true");
    expect(headings()).toEqual(["1. Address"]);
  });

  it("Next shows the method and the details, with the focus on the first field", () => {
    void open();
    type("url", "https://github.com/o/a");
    press("Next");
    expect(headings()).toEqual(["2. Method", "3. Details"]);
    expect(field("method")).toBeDefined();
    expect((document as any).activeElement).toBe(field("token"));
  });

  it("Back keeps the address, and Next again keeps a typed user name", () => {
    void open();
    type("url", "https://git.example.com/a/b");
    press("Next");
    choose("https-token");
    type("username", "ann");
    press("Back");
    expect(field("url")!.value).toBe("https://git.example.com/a/b");
    press("Next");
    expect(field("method")!.value).toBe("https-token");
    expect(field("username")!.value).toBe("ann");
  });

  it("an SSH address preselects the deploy key", () => {
    void open();
    type("url", SSH);
    press("Next");
    expect(field("method")!.value).toBe("ssh-deploy-key");
  });

  it("an https address with the deploy key asks for the SSH address", async () => {
    await add("https://github.com/o/a", "ssh-deploy-key", {}, {});
    // the first press found no SSH address
    expect(errors()).toEqual(["Fill in the repository URL."]);
    expect(walk(root()).some((e) => e.textContent === "SSH address")).toBe(true);
    type("url", SSH);
    press("Add repository");
    await flush();
    expect(saves()[0]!.body).toEqual({ url: SSH, method: "ssh-deploy-key" });
  });

  it("a duplicate is shown on the address view with the address marked", async () => {
    queued["POST /api/repos"] = [{ status: 409, error: "you have that repository already" }];
    await add("https://github.com/o/a", undefined, { token: TOKEN });
    expect(headings()).toEqual(["1. Address"]);
    expect(errors()).toEqual(["you have that repository already"]);
    expect(field("url")!.attrs["aria-invalid"]).toBe("true");
  });

  it("the GitHub App help says the test follows the save", () => {
    void open();
    type("url", "https://github.com/o/a");
    press("Next");
    choose("github-app");
    expect(root().textContent).toContain("The connection is tested right after you save.");
    expect(root().textContent).not.toContain("press Test connection");
  });
});

describe("save, test and read-back", () => {
  it.each([
    ["github-token", "https://github.com/o/a", { token: TOKEN }],
    ["https-token", "https://git.example.com/a/b", { username: "ann", token: TOKEN }],
    ["ssh-deploy-key", SSH, {}],
    ["github-app", "https://github.com/o/a", {}],
  ])("%s: the save is followed by the test with no click between", async (method, url, fields) => {
    await add(url, method, fields);
    expect(posts()).toEqual(["POST /api/repos", "POST /api/repos/id1/test"]);
    expect(root().textContent).toContain("Connected");
    expect(button("Done")).toBeDefined();
  });

  it("the server's own access is saved and not tested", async () => {
    await add("https://github.com/o/a", "none");
    expect(posts()).toEqual(["POST /api/repos"]);
    expect(root().textContent).toContain("Not verified");
    expect(root().textContent).toContain(rc.NONE_REASON);
    expect(button("Test again")).toBeUndefined();
    expect(button("Done")).toBeDefined();
  });

  it("shows what is stored, never the token", async () => {
    await add("https://git.example.com/a/b", "https-token", { username: "ann", token: TOKEN });
    const text = root().textContent;
    expect(text).toContain(rc.TOKEN_STORED);
    expect(text).toContain("https://git.example.com/a/b");
    expect(text).toContain("HTTPS user name + token (ann)");
    expect(text).toContain("Read: The repository can be read.");
    expect(text).toContain("Write: Write access works. Nothing was pushed.");
    for (const e of [root(), ...walk(root())]) {
      expect(e.value).not.toContain(TOKEN);
      expect(e.textContent).not.toContain(TOKEN);
    }
    expect(field("token")).toBeUndefined();
  });

  it("shows the public key and the hint for a deploy key", async () => {
    await add("https://github.com/o/a", "ssh-deploy-key", { url: SSH });
    expect(root().textContent).toContain(list[0].publicKey);
    expect(root().textContent).toContain(repos.DEPLOY_KEY_HINT);
    expect(root().textContent).not.toContain(rc.TOKEN_STORED);
  });

  it("Change details shows what is stored, and an unchanged Continue sends nothing", async () => {
    await add("https://git.example.com/a/b", "https-token", { username: "alice", token: TOKEN });
    press("Change details");
    expect(headings()).toEqual(["1. Method", "2. Details"]);
    expect(field("username")!.value).toBe("alice");
    expect(field("token")!.value).toBe("");
    const before = sent.length;
    press("Continue");
    expect(sent).toHaveLength(before);
    expect(field("replace")).toBeUndefined();
    expect(button("Done")).toBeDefined();
  });

  it("a saved change shows in the form, and the same values send nothing", async () => {
    void change(httpsRec());
    type("username", "bob");
    await replaceSignIn();
    press("Change details");
    expect(field("username")!.value).toBe("bob");
    const before = sent.length;
    press("Continue");
    expect(sent).toHaveLength(before);
  });

  it("after https to ssh the form has no extra address input", async () => {
    void change(httpsRec());
    choose("ssh-deploy-key");
    type("url", SSH);
    await replaceSignIn();
    press("Change details");
    expect(field("url")).toBeUndefined();
    const before = sent.length;
    press("Continue");
    expect(sent).toHaveLength(before);
  });

  it("a user name typed before the method is switched away and back is still there", () => {
    void open();
    type("url", "https://git.example.com/a/b");
    press("Next");
    choose("https-token");
    type("username", "ann");
    choose("github-token");
    choose("https-token");
    expect(field("username")!.value).toBe("ann");
  });
});

describe("a verification that did not succeed", () => {
  it("failed: shows the checks, keeps the repository, and Test again can turn it to Connected", async () => {
    testResult = connection(false);
    await add("https://github.com/o/a", undefined, { token: TOKEN });
    expect(root().textContent).toContain("Verification failed");
    expect(root().textContent).toContain("Read: The host did not accept the token.");
    expect(sent.some((s) => s.method === "DELETE")).toBe(false);
    testResult = connection(true);
    press("Test again");
    await flush();
    expect(posts().filter((p) => p.endsWith("/test"))).toHaveLength(2);
    expect(root().textContent).toContain("Connected");
    expect(root().textContent).not.toContain("Verification failed");
  });

  it("Change details asks for the token again and tests the new sign-in", async () => {
    testResult = connection(false);
    await add("https://github.com/o/a", undefined, { token: TOKEN });
    press("Change details");
    expect(field("token")!.value).toBe("");
    type("token", `${TOKEN}2`);
    press("Continue");
    expect(saves()).toHaveLength(1);
    tick();
    press("Replace the sign-in");
    await flush();
    expect(posts()).toEqual(["POST /api/repos", "POST /api/repos/id1/test", "PUT /api/repos/id1/auth", "POST /api/repos/id1/test"]);
  });

  it("a busy test: shows the sentence and offers Test again", async () => {
    queued["POST /api/repos/id1/test"] = [{ status: 409, error: "a test of this repository is running already; wait for it to finish" }];
    await add("https://github.com/o/a", undefined, { token: TOKEN });
    expect(root().textContent).toContain("Not verified");
    expect(root().textContent).toContain("a test of this repository is running already; wait for it to finish");
    expect(button("Test again")).toBeDefined();
  });

  it("a lost answer says the server could not be reached", async () => {
    queued["POST /api/repos/id1/test"] = ["throw"];
    await add("https://github.com/o/a", undefined, { token: TOKEN });
    expect(root().textContent).toContain("Not verified");
    expect(root().textContent).toContain("Could not reach the server.");
  });
});

describe("the returned record", () => {
  const addOk = () => {
    const done = open();
    type("url", "https://github.com/o/a");
    press("Next");
    type("token", TOKEN);
    press("Add repository");
    return done;
  };

  it("has connection when the test answered ok", async () => {
    const done = addOk();
    await flush();
    press("Done");
    const rec = await done;
    expect(rec).toMatchObject({ id: "id1", url: "https://github.com/o/a", method: "github-token" });
    expect(rec.connection.ok).toBe(true);
    expect(rec.token).toBeUndefined();
  });

  it("has no connection when a later test could not run", async () => {
    const done = addOk();
    await flush();
    press("Change details");
    type("token", `${TOKEN}2`);
    press("Continue");
    tick();
    queued["POST /api/repos/id1/test"] = ["throw"];
    press("Replace the sign-in");
    await flush();
    press("Done");
    expect((await done).connection).toBeUndefined();
  });

  it("has no connection after a change to none", async () => {
    const done = addOk();
    await flush();
    press("Change details");
    choose("none");
    await replaceSignIn();
    press("Done");
    const rec = await done;
    expect(rec.method).toBe("none");
    expect(rec.connection).toBeUndefined();
  });

  it("has no connection when Test again could not run", async () => {
    const done = addOk();
    await flush();
    queued["POST /api/repos/id1/test"] = ["throw"];
    press("Test again");
    await flush();
    press("Done");
    expect((await done).connection).toBeUndefined();
  });

  it("has none after an uncertain save whose re-read failed", async () => {
    const done = addOk();
    await flush();
    press("Change details");
    type("token", `${TOKEN}2`);
    queued["PUT /api/repos/id1/auth"] = [{ status: 500, error: "down" }];
    queued["GET /api/repos"] = [{ status: 500, error: "down" }];
    press("Continue");
    tick();
    press("Replace the sign-in");
    await flush();
    key("Escape");
    expect((await done).connection).toBeUndefined();
  });

  it("resolves undefined for a change, and the dialog is the one of ui/repos.js", async () => {
    const done = change(httpsRec());
    press("Continue");
    expect(await done).toBeUndefined();
    expect(repos.repoDialog).toBe(rc.repoDialog);
  });
});

describe("the confirm step", () => {
  it("sends nothing until the box is ticked, and names what is replaced", async () => {
    const done = change(httpsRec());
    choose("github-token");
    type("token", TOKEN);
    press("Continue");
    expect(sent).toEqual([]);
    const text = root().textContent;
    expect(text).toContain("https://git.example.com/a/b");
    expect(text).toContain("The stored token is deleted.");
    expect(text).toContain("Watchers of this repository may stop");
    const go = button("Replace the sign-in")!;
    expect(go.disabled).toBe(true);
    tick();
    expect(go.disabled).toBe(false);
    tick(false);
    expect(go.disabled).toBe(true);
    // a disabled button sends no click in a browser, so nothing was sent
    expect(sent).toEqual([]);
    tick();
    go.click();
    await flush();
    expect(saves()).toHaveLength(1);
    void done;
  });

  it("Back keeps what was typed", () => {
    void change(httpsRec());
    type("username", "ann2");
    press("Continue");
    press("Back");
    expect(field("username")!.value).toBe("ann2");
  });

  it("a 400 shows in the form, reads nothing, and a retry needs the confirm step again", async () => {
    void change(httpsRec());
    type("username", "ann2");
    queued["PUT /api/repos/id1/auth"] = [{ status: 400, error: "the user name is not valid" }];
    await replaceSignIn();
    expect(errors()).toEqual(["the user name is not valid"]);
    expect(sent.some((s) => s.method === "GET")).toBe(false);
    press("Continue");
    expect(field("replace")).toBeDefined();
    expect(saves()).toHaveLength(1);
  });
});

describe("an uncertain save", () => {
  const toDeployKey = async (answer: Answer) => {
    const done = change(httpsRec(), {});
    choose("ssh-deploy-key");
    type("url", SSH);
    queued["PUT /api/repos/id1/auth"] = [answer];
    await replaceSignIn();
    return { done };
  };

  it.each([
    ["a 500", { status: 500, error: "the repository was changed, but an old key is still in the Keychain", apply: true } as Answer],
    ["a lost answer", { status: 0, error: "x", apply: true } as Answer],
  ])("%s: reads the record, shows what is stored and asks to confirm again", async (_name, answer) => {
    await toDeployKey(answer);
    expect(sent.filter((s) => s.method === "GET")).toHaveLength(1);
    expect(root().textContent).toContain("Stored now: SSH deploy key");
    expect(root().textContent).toContain(answer !== "throw" && answer.status === 500 ? "an old key is still in the Keychain" : "Could not reach the server.");
    // the original method again
    choose("https-token");
    type("url", "https://git.example.com/a/b");
    type("token", TOKEN);
    press("Continue");
    expect(field("replace")).toBeDefined();
    expect(root().textContent).toContain("The last change may not have finished.");
    expect(root().textContent).toContain("The stored deploy key is deleted and stops working.");
    tick();
    press("Replace the sign-in");
    await flush();
    expect(saves()).toHaveLength(2);
    // the retry ends in the read-back, and an unchanged Change details needs no request
    expect(root().textContent).toContain("Connected");
    press("Change details");
    const before = sent.length;
    press("Continue");
    expect(sent).toHaveLength(before);
  });

  it("a 500 that changed nothing keeps the attempted method and the typed token", async () => {
    void change({ id: "id1", url: "https://github.com/o/a", method: "github-token" });
    list = [{ id: "id1", url: "https://github.com/o/a", method: "github-token" }];
    choose("https-token");
    type("username", "bob");
    type("token", TOKEN);
    queued["PUT /api/repos/id1/auth"] = [{ status: 500, error: "down" }];
    await replaceSignIn();
    expect(field("method")!.value).toBe("https-token");
    expect(field("username")!.value).toBe("bob");
    expect(field("token")!.value).toBe(TOKEN);
    expect(root().textContent).toContain("Stored now: GitHub fine-grained personal access token");
  });

  it("when the re-read fails after a transport change, the retry asks for an address", async () => {
    queued["GET /api/repos"] = [{ status: 500, error: "down" }];
    await toDeployKey({ status: 500, error: "the change failed", apply: true });
    choose("https-token");
    // the stored address is not known: the form asks for the address of the chosen method
    expect(walk(root()).some((e) => e.textContent === "HTTPS address")).toBe(true);
    type("username", "ann");
    type("token", TOKEN);
    press("Continue");
    expect(errors()[0]).toBe("Fill in the repository URL.");
    type("url", "https://git.example.com/a/b");
    press("Continue");
    tick();
    press("Replace the sign-in");
    await flush();
    expect(saves()[1]!.body).toEqual({ url: "https://git.example.com/a/b", method: "https-token", username: "ann", token: TOKEN });
  });

  it("a failed re-read says so, and the confirm step says the stored sign-in is not known", async () => {
    queued["GET /api/repos"] = [{ status: 500, error: "down" }];
    await toDeployKey({ status: 500, error: "the change failed" });
    expect(root().textContent).toContain("What is stored now could not be read.");
    // a token method asks for its token
    choose("github-token");
    press("Continue");
    expect(errors()[0]).toBe("Fill in the repository URL.");
    type("url", "https://github.com/o/a");
    press("Continue");
    expect(errors()[0]).toBe("Fill in the token.");
    type("token", TOKEN);
    press("Continue");
    expect(root().textContent).toContain("What is stored now is not known.");
  });
});

describe("closing during a request", () => {
  const start = async () => {
    const done = open();
    type("url", "https://github.com/o/a");
    press("Next");
    type("token", TOKEN);
    hold("POST /api/repos");
    press("Add repository");
    await flush();
    return { done };
  };
  const watch = (p: Promise<any>) => {
    const state = { done: false, value: undefined as any };
    void p.then((v) => {
      state.done = true;
      state.value = v;
    });
    return state;
  };

  it("Escape and a second press do nothing while the save runs", async () => {
    await start();
    key("Escape");
    expect(root().children).toHaveLength(1);
    press("Add repository");
    await flush();
    expect(sent).toHaveLength(1);
    release("POST /api/repos");
    await flush();
  });

  it("a replaced root keeps the newer content, toasts, resolves with the record and tests nothing", async () => {
    const w = watch((await start()).done);
    const marker = new FakeElement("div");
    root().replaceChildren(marker);
    release("POST /api/repos");
    await flush();
    expect(root().children).toEqual([marker]);
    expect(toastText()).toBe("Repository added");
    expect(w.value).toMatchObject({ id: "id1" });
    expect(posts()).toEqual(["POST /api/repos"]);
    key("Escape");
    key("Tab");
    expect(root().children).toEqual([marker]);
    expect((document as any).listeners.keydown).toHaveLength(0);
  });

  it("a failure is toasted", async () => {
    const { done: p } = await start();
    const marker = new FakeElement("div");
    root().replaceChildren(marker);
    release("POST /api/repos", { status: 409, error: "that repository belongs to another account" });
    await flush();
    expect(toastText()).toBe("that repository belongs to another account");
    expect(root().children).toEqual([marker]);
    expect(await p).toBeUndefined();
  });

  it("the promise waits for a held save, also after keys closed the lost dialog", async () => {
    const w = watch((await start()).done);
    root().replaceChildren(new FakeElement("div"));
    key("Tab");
    key("Escape");
    await flush();
    expect(w.done).toBe(false);
    release("POST /api/repos");
    await flush();
    expect(w.done).toBe(true);
    expect(w.value.id).toBe("id1");
    expect(posts()).toEqual(["POST /api/repos"]);
  });

  it("the promise waits for a held change and resolves undefined", async () => {
    const w = watch(change(httpsRec()));
    type("username", "bob");
    hold("PUT /api/repos/id1/auth");
    await replaceSignIn();
    root().replaceChildren(new FakeElement("div"));
    key("Escape");
    await flush();
    expect(w.done).toBe(false);
    release("PUT /api/repos/id1/auth");
    await flush();
    expect(w.done).toBe(true);
    expect(w.value).toBeUndefined();
    expect(posts()).toEqual(["PUT /api/repos/id1/auth"]);
  });

  it("the promise waits for a held re-read and sends nothing more", async () => {
    const w = watch(change(httpsRec()));
    type("username", "bob");
    queued["PUT /api/repos/id1/auth"] = [{ status: 500, error: "down" }];
    hold("GET /api/repos");
    await replaceSignIn();
    root().replaceChildren(new FakeElement("div"));
    key("Tab");
    await flush();
    expect(w.done).toBe(false);
    release("GET /api/repos");
    await flush();
    expect(w.done).toBe(true);
    expect(sent.map((s) => s.method)).toEqual(["PUT", "GET"]);
  });

  it("the promise waits for a held test and returns that test's result", async () => {
    hold("POST /api/repos/id1/test");
    const done = open();
    const w = watch(done);
    type("url", "https://github.com/o/a");
    press("Next");
    type("token", TOKEN);
    press("Add repository");
    await flush();
    // Escape does nothing while the test runs
    key("Escape");
    expect(root().children).toHaveLength(1);
    expect(root().textContent).toContain("Testing the connection…");
    const marker = new FakeElement("div");
    root().replaceChildren(marker);
    key("Tab");
    await flush();
    expect(w.done).toBe(false);
    release("POST /api/repos/id1/test");
    await flush();
    expect(w.done).toBe(true);
    expect(w.value.connection.ok).toBe(true);
    expect(root().children).toEqual([marker]);
    expect(toastText()).toBe("Connection works");
  });
});

describe("pure helpers", () => {
  const rec = (method: string, over: object = {}) => ({ id: "r", url: "https://x/y", method, ...over });
  const lines = (r: any, body: any, o: object = {}) => rc.replaceLines(r, body, o);
  const WATCH = "Watchers of this repository may stop until the new sign-in works.";

  it("replaceLines for a token method", () => {
    expect(lines(rec("github-token"), { method: "https-token", username: "a", token: "t" })).toEqual(["Change the sign-in of https://x/y?", "The stored token is deleted.", WATCH]);
    expect(lines(rec("github-token"), { method: "github-token", token: "t" })[1]).toBe("The stored token is replaced by the new one.");
    expect(lines(rec("github-token"), { method: "github-token" })[1]).toBe("The stored token is kept.");
  });

  it("replaceLines for the other methods", () => {
    expect(lines(rec("ssh-deploy-key"), { method: "github-token", token: "t" })[1]).toBe("The stored deploy key is deleted and stops working. Remove it from the deploy keys of the repository.");
    expect(lines(rec("github-app"), { method: "ssh-deploy-key" })).toEqual([
      "Change the sign-in of https://x/y?",
      "The link to the app installation is removed. The app stays installed on GitHub.",
      "A new key is made. You add its public key to the repository as a deploy key.",
      WATCH,
    ]);
    expect(lines(rec("none"), { method: "ssh-deploy-key", url: SSH })).toContain(`The address changes to ${SSH}.`);
    expect(lines(rec("none"), { method: "ssh-deploy-key", url: SSH })[1]).toBe("No sign-in is stored for this repository now.");
    expect(lines(rec("ssh-deploy-key"), { method: "ssh-deploy-key" })[1]).toBe("The method stays the same; the server repairs what is missing.");
  });

  it("replaceLines after an uncertain save", () => {
    expect(lines(rec("github-token"), { method: "github-token", token: "t" }, { unsure: true })[1]).toBe("The last change may not have finished.");
    const unread = lines(rec("github-token"), { method: "none" }, { unsure: true, unread: true });
    expect(unread.slice(1, 3)).toEqual(["The last change may not have finished.", "What is stored now is not known. It is replaced by this sign-in."]);
    expect(unread).not.toContain("The stored token is deleted.");
  });

  it("verdict", () => {
    const v = rc.verdict({ connection: connection(true) });
    expect(v).toMatchObject({ state: "ok", title: "Connected" });
    expect(v.lines.map((l: any) => l.text)).toEqual(["Read: The repository can be read.", "Write: Write access works. Nothing was pushed."]);
    expect(rc.verdict({ connection: connection(false) })).toMatchObject({ state: "failed", title: "Verification failed" });
    expect(rc.verdict({ error: "boom" })).toEqual({ state: "unverified", title: "Not verified", reason: "boom", lines: [] });
    expect(rc.verdict({ method: "none" })).toEqual({ state: "unverified", title: "Not verified", reason: rc.NONE_REASON, lines: [], retry: false });
  });

  it("saveUnknown and storesToken", () => {
    expect(rc.saveUnknown(new TypeError("x"))).toBe(true);
    expect(rc.saveUnknown(Object.assign(new Error("x"), { status: 500 }))).toBe(true);
    expect(rc.saveUnknown(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    expect(rc.saveUnknown(Object.assign(new Error("x"), { status: 409 }))).toBe(false);
    expect(["github-token", "https-token"].every((m) => rc.storesToken(m))).toBe(true);
    expect(["ssh-deploy-key", "github-app", "none"].some((m) => rc.storesToken(m))).toBe(false);
  });
});
