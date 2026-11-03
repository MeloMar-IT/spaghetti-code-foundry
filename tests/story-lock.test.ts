import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../src/stories/local-store.js";
import { formatStoryFile } from "../src/stories/story-file.js";
import { GUARD_FILE, LOCK_FILE, pidAlive, withStoryLock } from "../src/stories/story-lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project with story 1; returns the project, the stories folder and the story file. */
function setup() {
  const d = mkdtempSync(join(tmpdir(), "scf-lock-"));
  dirs.push(d);
  const folder = join(d, ".scf", "stories");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "1-story.md");
  writeFileSync(file, formatStoryFile({ number: 1, title: "S", state: "open", kind: "story", labels: [], dependsOn: [], body: "", comments: [] }));
  const lock = join(folder, LOCK_FILE);
  const store = (o = {}) => new LocalStore(d, "local/x", { lockPollMs: 5, commit: false, ...o });
  const bodies = () => readFileSync(file, "utf8");
  return { d, folder, file, lock, store, bodies };
}
const leftovers = (folder: string): string[] => readdirSync(folder).filter((f) => !/^\d+-.*\.md$/.test(f));
const old = (p: string): void => utimesSync(p, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

describe("story lock", () => {
  it("pidAlive knows this process and a missing one", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("two writers wait while a live lock is held and both finish once it is gone", async () => {
    const t = setup();
    writeFileSync(t.lock, `${process.pid} other\n`);
    const before = t.bodies();
    let checks = 0;
    const alive = () => (checks++, true);
    const a = t.store({ alive }).comment(1, "from a");
    const b = t.store({ alive }).comment(1, "from b");
    await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(2));
    expect(t.bodies()).toBe(before);
    rmSync(t.lock);
    await Promise.all([a, b]);
    expect(t.bodies()).toContain("from a");
    expect(t.bodies()).toContain("from b");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("gives up after the limit and leaves the lock and the story alone", async () => {
    const t = setup();
    writeFileSync(t.lock, `${process.pid} other\n`);
    const before = t.bodies();
    await expect(t.store({ lockWaitMs: 40, alive: () => true }).comment(1, "x")).rejects.toThrow(/locked by process/);
    expect(readFileSync(t.lock, "utf8")).toBe(`${process.pid} other\n`);
    expect(t.bodies()).toBe(before);
  });

  it("takes over a lock of a dead process", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 old\n");
    await t.store({ alive: () => false }).comment(1, "x");
    expect(t.bodies()).toContain("x");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("does not remove a live lock that a successor put in during the takeover", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 old\n");
    const live = `${process.pid} successor\n`;
    const store = t.store({ lockWaitMs: 60, alive: (pid: number) => pid !== 4242, onStale: () => writeFileSync(t.lock, live) });
    await expect(store.comment(1, "x")).rejects.toThrow(/locked/);
    expect(readFileSync(t.lock, "utf8")).toBe(live);
  });

  it("lets two waiters that see the same stale lock both finish, one after the other", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 old\n");
    const second = t.store({ alive: () => false }).comment(1, "second");
    const first = t.store({ alive: () => false, onStale: () => second }).comment(1, "first");
    await Promise.all([first, second]);
    expect(t.bodies()).toContain("first");
    expect(t.bodies()).toContain("second");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("removes a guard left behind for more than 5 s, and waits for a young one", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 old\n");
    const guard = join(t.folder, GUARD_FILE);
    writeFileSync(guard, "1 x\n");
    await expect(t.store({ lockWaitMs: 40, alive: () => false }).comment(1, "x")).rejects.toThrow(/locked/);
    expect(existsSync(guard)).toBe(true);
    old(guard);
    await t.store({ alive: () => false }).comment(1, "x");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("waits for a young empty lock and takes over an old one", async () => {
    const t = setup();
    writeFileSync(t.lock, "");
    await expect(t.store({ lockWaitMs: 40 }).comment(1, "x")).rejects.toThrow(/locked/);
    old(t.lock);
    await t.store().comment(1, "x");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("rejects when the deadline falls while another writer holds the lock, and at once when it has passed", async () => {
    const t = setup();
    writeFileSync(t.lock, `${process.pid} other\n`);
    const before = t.bodies();
    const s = t.store({ alive: () => true });
    await expect(s.upsertStatusComment(1, "x", { create: true, deadline: Date.now() + 40 })).rejects.toThrow("out of time");
    await expect(s.upsertStatusComment(1, "x", { create: true, deadline: Date.now() - 1 })).rejects.toThrow("out of time");
    expect(t.bodies()).toBe(before);
  });

  it("clears a stale guard left by a crash, then takes over the stale lock", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 old\n");
    const guard = join(t.folder, GUARD_FILE);
    writeFileSync(guard, "4243 crashed\n");
    old(guard);
    await t.store({ alive: (pid: number) => pid !== 4242 }).comment(1, "after");
    expect(t.bodies()).toContain("after");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("keeps a fresh guard that replaced the stale one while the writer was checking", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 old\n");
    const guard = join(t.folder, GUARD_FILE);
    writeFileSync(guard, "4243 crashed\n");
    old(guard);
    const live = `${process.pid} successor\n`;
    let replaced = false;
    // The writer has read the guard as old, then another writer puts in its own (fresh) guard before the removal.
    const store = t.store({
      lockWaitMs: 60,
      alive: (pid: number) => pid !== 4242,
      onStale: () => {
        if (replaced) return;
        replaced = true;
        rmSync(guard);
        writeFileSync(guard, live);
      },
    });
    await expect(store.comment(1, "x")).rejects.toThrow(/locked/);
    expect(readFileSync(guard, "utf8")).toBe(live);
    expect(readFileSync(t.lock, "utf8")).toBe("4242 old\n");
  });

  it("removes only its own lock", async () => {
    const t = setup();
    await withStoryLock(t.folder, { waitMs: 10, pollMs: 5, alive: () => true }, () => writeFileSync(t.lock, "999 someone-else\n"));
    expect(readFileSync(t.lock, "utf8")).toBe("999 someone-else\n");
  });

  it("leaves no lock behind after a failed write", async () => {
    const t = setup();
    await expect(t.store().edit(1, { title: " ", body: "" })).rejects.toThrow(/title/);
    await expect(t.store().comment(2, "x")).rejects.toThrow(/does not exist/);
    expect(leftovers(t.folder)).toEqual([]);
  });
});

describe("synchronous story lock", () => {
  const run = (t: ReturnType<typeof setup>, o = {}) => t.store(o).sync(() => "");

  it("writes under the lock and leaves no lock behind", () => {
    const t = setup();
    run(t).comment(1, "sync");
    expect(t.bodies()).toContain("sync");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("fails with the locked message when a live lock is held", () => {
    const t = setup();
    writeFileSync(t.lock, `${process.pid} other\n`);
    const before = t.bodies();
    expect(() => run(t, { lockWaitMs: 40, alive: () => true }).comment(1, "x")).toThrow(/the stories are locked by process/);
    expect(t.bodies()).toBe(before);
  });

  it("takes over a lock of a process that is gone", () => {
    const t = setup();
    writeFileSync(t.lock, "4242 dead\n");
    let seen = "";
    run(t, { alive: () => false, onStale: (c: string) => { seen = c; } }).comment(1, "after takeover");
    expect(seen).toBe("4242 dead\n");
    expect(t.bodies()).toContain("after takeover");
    expect(leftovers(t.folder)).toEqual([]);
  });

  it("refuses an onStale that returns a promise, handles its rejection and leaves the stale lock alone", async () => {
    const t = setup();
    writeFileSync(t.lock, "4242 dead\n");
    const before = t.bodies();
    const hook = () => Promise.reject(new Error("hook failed"));
    expect(() => run(t, { alive: () => false, onStale: hook }).comment(1, "x")).toThrow("onStale must be synchronous");
    await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run here
    expect(t.bodies()).toBe(before);
    expect(readFileSync(t.lock, "utf8")).toBe("4242 dead\n");
  });

  it("passes on an error of a synchronous onStale and takes no lock", () => {
    const t = setup();
    writeFileSync(t.lock, "4242 dead\n");
    expect(() => run(t, { alive: () => false, onStale: () => { throw new Error("hook failed"); } }).comment(1, "x")).toThrow("hook failed");
    expect(readFileSync(t.lock, "utf8")).toBe("4242 dead\n");
  });

  it("is refused while an async writer holds the lock", async () => {
    const t = setup();
    await withStoryLock(t.folder, { waitMs: 50, pollMs: 5, alive: pidAlive }, () => {
      expect(() => run(t, { lockWaitMs: 50 }).comment(1, "x")).toThrow(/the stories are locked/);
    });
    expect(leftovers(t.folder)).toEqual([]);
  });
});
