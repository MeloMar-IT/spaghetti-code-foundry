import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mv: any;
let repos: any;
beforeAll(async () => {
  restore = installFakeDom();
  await import("../ui/repo-connect.js" as string); // first: the other order of the import cycle with ui/repos.js
  mv = await import("../ui/repo-move.js" as string);
  repos = await import("../ui/repos.js" as string);
});
afterAll(() => restore());

const flush = () => new Promise((r) => setTimeout(r, 0));
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const byLabel = (l: string) => walk(root()).find((e) => e.attrs["aria-label"] === l)!;
const button = (text: string) => walk(root()).find((e) => e.tag === "button" && e.textContent === text)!;
const checkbox = (text: string) => walk(root()).find((e) => e.tag === "label" && e.textContent === text)!.all("input")[0]!;
const key = (k: string) => (document as any).listeners.keydown.forEach((fn: any) => fn({ key: k, shiftKey: false, preventDefault: () => {} }));
const text = () => root().textContent;
const alertText = () => walk(root()).find((e) => e.attrs.role === "alert")!.textContent;
const typeName = (v: string) => {
  const f = byLabel("Name of the new repository");
  f.value = v;
  f.fire("input");
};

const local = { id: "l1", url: "/Users/x/my app", method: "local" };
const plan = (over: any[] = []) => [{ number: 1, title: "First", state: "open", status: "create" }, ...over];
const dry = (over: any = {}) => ({
  dryRun: true, github: "o/my-app", repository: "create",
  refs: [{ ref: "refs/heads/main", status: "push" }, { ref: "refs/heads/develop", status: "push" }, { ref: "refs/heads/scf/stories", status: "push" }, { ref: "refs/tags/v1", status: "push" }],
  stories: { plan: plan(), created: [], done: [] }, confirm: { token: TOKEN, expiresAt: 1 }, ...over,
});
const TOKEN = "T".repeat(43);
const real = { dryRun: false, github: "o/my-app", repoId: "g1", repository: "created", refs: [{ ref: "refs/heads/main", status: "pushed" }, { ref: "refs/heads/dev", status: "up-to-date" }], stories: { plan: plan(), created: [{ story: 1, issue: 5 }], done: [1] }, switched: { watchers: ["w1", "w2"], settings: "none", kept: [], removed: "l1" } };
const gh = [
  { id: "g2", url: "https://github.com/o/b", method: "github-token", github: "o/b" },
  { id: "g1", url: "https://github.com/o/a", method: "github-app", github: "o/a" },
  { id: "x", url: "https://github.com/o/c", method: "https-token", github: "o/c" },
  { id: "y", url: "/p", method: "local" },
  { id: "z", url: "https://github.com/o/d", method: "github-token" },
];

describe("the helpers", () => {
  it("lists the usable GitHub records, sorted", () => {
    expect(mv.moveTargets(gh)).toEqual([{ id: "g1", github: "o/a" }, { id: "g2", github: "o/b" }]);
    expect(mv.moveTargets(undefined)).toEqual([]);
  });

  it("suggests a name from the folder", () => {
    expect(mv.suggestName("/Users/x/my app")).toBe("my-app");
    expect(mv.suggestName("/a/b/app.git")).toBe("app");
    expect(mv.suggestName("/a/b/..")).toBe("project");
    expect(mv.suggestName("")).toBe("project");
    expect(mv.suggestName(`/a/${"x".repeat(300)}`)).toHaveLength(100);
  });

  it("checks names like the server", () => {
    for (const ok of ["app", "o/app", "a.b_c-d"]) expect(mv.moveNameProblem(ok), ok).toBe("");
    for (const bad of ["", ".", "..", "a/b/c", "x.git", "a b", "o/"]) expect(mv.moveNameProblem(bad), bad).not.toBe("");
    expect(mv.moveNameProblem("o/app", { owner: false })).not.toBe("");
    expect(mv.moveNameProblem("app", { owner: false })).toBe("");
    expect(mv.moveInputProblem({ mode: "pick", repoId: "" })).toContain("Choose");
    expect(mv.moveInputProblem({ mode: "pick", repoId: "g1" })).toBe("");
  });

  it("builds the body", () => {
    expect(mv.moveBody({ mode: "pick", repoId: "g1" }, true)).toEqual({ target: { repoId: "g1" }, includeClosed: false, dryRun: true });
    expect(mv.moveBody({ mode: "create", name: " app ", includeClosed: true }, false)).toEqual({ target: { create: { name: "app", private: true } }, includeClosed: true, dryRun: false });
    expect(mv.moveBody({ mode: "create", name: "app", private: false }, true).target.create.private).toBe(false);
  });

  it("groups refs and tells the lines", () => {
    expect(mv.refGroups(dry().refs)).toEqual({ branches: ["main", "develop", "scf/stories"], tags: ["v1"] });
    expect(mv.repositoryLine(dry())).toBe("o/my-app will be created (private)");
    expect(mv.repositoryLine(dry(), { private: false })).toBe("o/my-app will be created (public)");
    expect(mv.repositoryLine(dry({ repository: "exists" }))).toBe("o/my-app exists on GitHub and will be used");
    expect(mv.repositoryLine(dry({ repository: "picked" }))).toBe("o/my-app (one of your repositories)");
    expect(mv.repositoryLine(dry({ repository: "created" }))).toBe("o/my-app was created");
    expect(mv.storyLine({ number: 3, title: "T", status: "create" })).toBe("#3 T: will be created");
    expect(mv.storyLine({ number: 3, title: "T", status: "already-moved", githubIssue: 9 })).toBe("#3 T: already moved (#9 on GitHub)");
    expect(mv.storyLine({ number: 3, title: "T", status: "unreadable", reason: "bad yaml" })).toBe("#3: cannot be read (bad yaml)");
    expect(mv.storyLine({ number: 3, title: "T", status: "too-large" })).toContain("too large");
    expect(mv.blockedStories(dry({ stories: { plan: plan([{ number: 2, title: "x", state: "open", status: "too-large" }]) } }))).toHaveLength(1);
    expect(mv.doneLine(real)).toBe("Moved to o/my-app: 1 branch or tag pushed, 1 already up to date; 1 story created on GitHub; 2 watchers moved. The local record is removed; the folder and its .scf/stories files stay.");
  });
});

describe("the dialog", () => {
  beforeEach(() => {
    root().replaceChildren();
    (document as any).listeners.keydown = [];
    (document as any).getElementById("toast").textContent = "";
  });
  const api = (...answers: any[]) => {
    const q = [...answers];
    return { moveToGithub: vi.fn(async (_id: string, _b: any) => { const x = q.length > 1 ? q.shift() : q[0]; if (x instanceof Error) throw x; return x; }) };
  };
  const open = async (a: any, list: any[] = []) => {
    const p = mv.moveDialog(local, { repos: list, a });
    await flush();
    return p as Promise<any>;
  };
  const check = async () => { button("Check").click(); await flush(); };

  it("opens on Create without targets, with Private ticked and Move off", async () => {
    const p = open(api(dry()));
    await flush();
    expect(byLabel("Name of the new repository").value).toBe("my-app");
    expect(walk(root()).find((e) => e.tag === "input" && e.value === "pick")!.disabled).toBe(true);
    expect(checkbox("Private").checked).toBe(true);
    expect(checkbox("Also move closed stories").checked).toBe(false);
    expect(button("Yes, publish").disabled).toBe(true);
    expect(audit(root())).toEqual([]);
    key("Escape");
    expect(await p).toEqual({ called: false });
  });

  it("opens on Pick when there are targets", async () => {
    const a = api(dry({ repository: "picked", github: "o/a" }));
    const p = open(a, gh);
    await flush();
    expect(walk(root()).filter((e) => e.tag === "option").map((o) => o.textContent)).toEqual(["o/a", "o/b"]);
    await check();
    expect(a.moveToGithub).toHaveBeenCalledWith("l1", { target: { repoId: "g1" }, includeClosed: false, dryRun: true });
    expect(text()).toContain("o/a (one of your repositories)");
    key("Escape");
    await p;
  });

  it("checks with a dry run and lists what will happen", async () => {
    const a = api(dry({ stories: { plan: plan([{ number: 2, title: "Old", state: "open", status: "already-moved", githubIssue: 8 }]) } }));
    const p = open(a);
    await check();
    expect(a.moveToGithub).toHaveBeenCalledWith("l1", { target: { create: { name: "my-app", private: true } }, includeClosed: false, dryRun: true });
    expect(text()).toContain("o/my-app will be created (private)");
    for (const t of ["Branches (3)", "main", "develop", "scf/stories", "Tags (1)", "v1", "#1 First: will be created", "#2 Old: already moved (#8 on GitHub)"]) expect(text()).toContain(t);
    expect(button("Yes, publish").disabled).toBeUndefined();
    expect(audit(root())).toEqual([]);
    key("Escape");
    await p;
  });

  it("clears the result when an input changes, and moves with the checked body only", async () => {
    const a = api(dry(), dry(), dry(), real);
    const p = open(a);
    await check();
    typeName("other");
    expect(button("Yes, publish").disabled).toBe(true);
    expect(text()).not.toContain("Branches");
    await check();
    expect(a.moveToGithub).toHaveBeenLastCalledWith("l1", { target: { create: { name: "other", private: true } }, includeClosed: false, dryRun: true });
    checkbox("Also move closed stories").checked = true;
    checkbox("Also move closed stories").fire("change");
    expect(button("Yes, publish").disabled).toBe(true);
    await check();
    button("Yes, publish").click();
    await flush();
    expect(a.moveToGithub).toHaveBeenLastCalledWith("l1", { target: { create: { name: "other", private: true } }, includeClosed: true, dryRun: false, confirm: TOKEN });
    expect(text()).toContain("Moved to o/my-app: 1 branch or tag pushed");
    expect((document as any).getElementById("toast").textContent).toContain("Moved to GitHub");
    expect(button("Close")).toBeDefined();
    expect(button("Yes, publish").disabled).toBe(true);
    key("Escape");
    expect(await p).toMatchObject({ called: true, result: real });
  });

  it("sends one request on a double click, and cannot be closed while it runs", async () => {
    let release!: (v: any) => void;
    const a = { moveToGithub: vi.fn(async (_id: string, b: any) => (b.dryRun ? dry() : new Promise((r) => { release = r; }))) };
    const p = open(a);
    await check();
    button("Yes, publish").click();
    button("Yes, publish").click();
    await flush();
    expect(a.moveToGithub.mock.calls.filter((c) => !c[1].dryRun)).toHaveLength(1);
    expect(text()).toContain("Moving…");
    expect(text()).toContain("a few minutes");
    expect(button("Cancel").disabled).toBe(true);
    key("Escape");
    expect(root().children.length).toBe(1);
    release(real);
    await flush();
    key("Escape");
    expect(await p).toMatchObject({ called: true });
  });

  it("shows the server's sentence after a failed move and allows another try; any way of closing keeps `called`", async () => {
    const a = api(dry(), Object.assign(new Error("the push was refused for refs/heads/main: rewrites"), { status: 409 }));
    const p = open(a);
    await check();
    button("Yes, publish").click();
    await flush();
    expect(alertText()).toContain("the push was refused for refs/heads/main");
    // the token is used up: the check must be made again before another try
    expect(button("Yes, publish").disabled).toBe(true);
    expect(text()).toContain("Check again");
    expect(button("Cancel").disabled).toBeUndefined();
    key("Escape"); // the modal itself resolves undefined: the dialog still reports the call
    expect(await p).toEqual({ called: true });
  });

  it("shows an empty branch or tag group as nothing, never as a null child", async () => {
    const p = open(api(dry({ refs: [{ ref: "refs/heads/main", status: "push" }] })));
    await check();
    expect(text()).toContain("Branches (1)");
    expect(text()).not.toContain("Tags");
    // the native DOM would draw a null child as the text "null"
    expect(walk(root()).flatMap((e) => e.children).some((c) => c === null || c === undefined || c === "null")).toBe(false);
    key("Escape");
    await p;
  });

  it("shows a failed check and keeps Move off", async () => {
    const p = open(api(new Error("create.name must be a text")));
    await check();
    expect(alertText()).toContain("create.name");
    expect(button("Yes, publish").disabled).toBe(true);
    key("Escape");
    expect(await p).toEqual({ called: false });
  });

  it("does not check a bad name", async () => {
    const a = api(dry());
    const p = open(a);
    typeName("a b");
    await check();
    expect(a.moveToGithub).not.toHaveBeenCalled();
    expect(alertText()).toContain("Use");
    key("Escape");
    await p;
  });

  it("keeps Yes, publish off without a token, and says nothing was sent after a 'Nothing was published' refusal; a new check makes it work again", async () => {
    const noToken = dry();
    delete noToken.confirm;
    const refused = Object.assign(new Error("Nothing was published: the confirmation is used up or has expired; run the check again"), { status: 409 });
    const a = api(noToken, dry(), refused, dry());
    const p = open(a);
    await check();
    expect(button("Yes, publish").disabled).toBe(true);
    await check();
    expect(button("Yes, publish").disabled).toBeUndefined();
    button("Yes, publish").click();
    await flush();
    expect(alertText()).toContain("Nothing was published");
    expect(text()).toContain("Nothing was sent");
    expect(button("Yes, publish").disabled).toBe(true);
    await check();
    expect(button("Yes, publish").disabled).toBeUndefined();
    expect(text()).toContain("nothing leaves this computer until you press Yes, publish");
    key("Escape");
    await p;
  });

  it("moveBody carries the token of the check in a real move only", () => {
    expect(mv.moveBody({ mode: "pick", repoId: "g1" }, false, TOKEN)).toEqual({ target: { repoId: "g1" }, includeClosed: false, dryRun: false, confirm: TOKEN });
    expect(mv.moveBody({ mode: "pick", repoId: "g1" }, true, TOKEN)).not.toHaveProperty("confirm");
    expect(mv.moveBody({ mode: "pick", repoId: "g1" }, false)).not.toHaveProperty("confirm");
  });

  it("turns Move off when a story cannot be moved", async () => {
    const bad = dry({ stories: { plan: plan([{ number: 2, title: "?", state: "unknown", status: "unreadable", reason: "bad yaml" }]) } });
    const p = open(api(bad));
    await check();
    expect(button("Yes, publish").disabled).toBe(true);
    expect(text()).toContain("#2: cannot be read (bad yaml)");
    expect(text()).toContain("Fix or remove them, then check again");
    key("Escape");
    await p;
  });
});

describe("the button on My repositories", () => {
  const realFetch = globalThis.fetch;
  let list: any[];
  let calls: string[];
  beforeEach(() => {
    calls = [];
    list = [{ id: "l1", url: "/Users/x/app", method: "local" }, { id: "g1", url: "https://github.com/o/a", method: "github-token", github: "o/a" }];
    root().replaceChildren();
    (document as any).listeners.keydown = [];
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
    (globalThis as any).fetch = async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url}`);
      if (url === "/api/repos/methods") return reply({ methods: ["github-token", "none"], githubApp: { available: false } });
      if (url.startsWith("/api/runs")) return reply([]);
      if (url.endsWith("/move-to-github")) {
        list = list.filter((r) => r.id !== "l1");
        return reply(dry());
      }
      return reply([...list]);
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  const rowButtons = (main: FakeElement, id: string) => main.all("tr").find((r) => r.attrs["data-repo"] === id)!.all("button").map((b) => b.textContent);

  it("is on an own local row only", async () => {
    const main = new FakeElement("div");
    await repos.renderRepos(main, { admin: false });
    expect(rowButtons(main, "l1")).toContain("Move to GitHub");
    expect(rowButtons(main, "g1")).not.toContain("Move to GitHub");
    const ro = new FakeElement("div");
    await repos.renderRepos(ro, { admin: false, readOnly: true });
    expect(rowButtons(ro, "l1")).not.toContain("Move to GitHub");
    const all = new FakeElement("div");
    const { ALL_SCOPE } = await import("../ui/admin-repos.js" as string);
    await repos.renderRepos(all, { admin: true, scope: { ...ALL_SCOPE, load: async () => list } });
    expect(rowButtons(all, "l1")).not.toContain("Move to GitHub");
  });

  it("loads the list again after a real move call", async () => {
    const main = new FakeElement("div");
    await repos.renderRepos(main, { admin: false });
    main.all("tr").find((r) => r.attrs["data-repo"] === "l1")!.all("button").find((b) => b.textContent === "Move to GitHub")!.click();
    await flush();
    button("Check").click();
    await flush();
    button("Yes, publish").click();
    await flush();
    expect(calls.filter((c) => c === "POST /api/repos/l1/move-to-github")).toHaveLength(2);
    const before = calls.filter((c) => c === "GET /api/repos").length;
    key("Escape");
    await flush();
    await flush();
    expect(calls.filter((c) => c === "GET /api/repos").length).toBe(before + 1);
    expect(main.all("tr").some((r) => r.attrs["data-repo"] === "l1")).toBe(false);
  });
});
