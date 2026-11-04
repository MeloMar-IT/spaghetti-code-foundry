import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let form: any;
beforeAll(async () => {
  restore = installFakeDom();
  form = await import("../ui/watcher-form.js" as string);
});
afterAll(() => restore());

let sent: { method: string; url: string; body: any }[];
let answers: { status: number; error: string }[];
const realFetch = globalThis.fetch;

const ann = { name: "Ann", email: "ann@example.com", role: "user", status: "active" };
const github = { id: "gh", url: "https://github.com/o/a", method: "github-token", settings: {}, account: ann };
const local = { id: "loc", url: "/srv/my-app", method: "local", settings: {}, account: ann };

beforeEach(() => {
  sent = [];
  answers = [];
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") return reply([]);
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.shift();
    return answer ? reply({ error: answer.error }, answer.status) : reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 5));
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (name: string) => walk(root()).find((e) => e.attrs.name === name)!;
const button = (text: string) => walk(root()).find((e) => e.tag === "button" && e.textContent === text)!;
const labelled = (text: string) => walk(root()).find((e) => e.tag === "label" && e.textContent.startsWith(text))!;
const inputOf = (text: string) => walk(labelled(text)).find((e) => e.tag === "input" || e.tag === "textarea")!;
/** True when the element or a parent is hidden. */
const hidden = (el: FakeElement): boolean => el.hidden || (el.parent ? hidden(el.parent) : false);
const NOTE = "A local project: the watcher starts the stories set to";
const open = (repos: object[], existing: object | null = null) => form.repoWatcherDialog({ repos, flows: [{ name: "issue-gitflow" }], existing }) as Promise<unknown>;
const choose = (id: string) => {
  const select = field("repo");
  select.value = id;
  select.fire("change");
};
const note = () => walk(root()).find((e) => e.tag === "p" && e.textContent.startsWith(NOTE))!;
const releaseBox = () => inputOf("Build release files");

describe("the watcher dialog for a local project", () => {
  it("shows a note and hides the trigger label, and shows them again for a GitHub repository", async () => {
    void open([github, local]); // the list is sorted by address: the local project is first
    choose("gh");
    expect(hidden(note())).toBe(true);
    expect(hidden(labelled("Trigger label"))).toBe(false);
    choose("loc");
    expect(hidden(note())).toBe(false);
    expect(hidden(labelled("Trigger label"))).toBe(true);
    choose("gh");
    expect(hidden(note())).toBe(true);
    expect(hidden(labelled("Trigger label"))).toBe(false);
  });

  it("starts local when the local project is the only one", async () => {
    void open([local]);
    expect(hidden(note())).toBe(false);
    expect(hidden(labelled("Trigger label"))).toBe(true);
  });

  it("sends release_build false after the switch from GitHub with the box ticked", async () => {
    void open([github, local]);
    choose("gh");
    const source = field("source");
    source.value = "schedule";
    source.fire("change");
    inputOf("Id").value = "w";
    inputOf("Chore").value = "tidy";
    releaseBox().checked = true;
    choose("loc");
    expect(releaseBox().checked).toBe(false);
    expect(hidden(releaseBox())).toBe(true);
    button("Save watcher").click();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("/api/admin/repos/loc/watchers");
    expect(sent[0]!.body.release_build).toBe(false);
  });

  it("sends release_build false when it edits a stored incompatible watcher", async () => {
    const existing = { id: "w", repoId: "loc", source: "schedule", task: "t", enabled: true, github_repo: "local:my-app-12345678", flow: "release-daily", label: "go", every: "1d", max_per_tick: 1, release_build: true, vars: {} };
    void open([local], existing);
    button("Save watcher").click();
    await flush();
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.body.release_build).toBe(false);
  });

  it("shows a refusal of the server in the alert and marks the field", async () => {
    const sentence = "source: a local project has no pull requests, so it cannot have a watcher for review comments";
    answers = [{ status: 400, error: sentence }];
    void open([local]);
    inputOf("Id").value = "w";
    button("Save watcher").click();
    await flush();
    const alert = walk(root()).find((e) => e.attrs.role === "alert")!;
    expect(alert.textContent).toContain(sentence);
    expect(String(field("source").attrs["aria-invalid"])).toBe("true");
  });
});
