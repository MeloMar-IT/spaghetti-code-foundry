import { beforeEach, describe, expect, it } from "vitest";
import { isStatusComment, STATUS_MARKER } from "../src/github.js";
import type { StoryStore } from "../src/stories/store.js";

/** The fields gh exports for a comment and for a label (`gh issue view --json comments,labels`). */
const GH_COMMENT_KEYS = ["author", "authorAssociation", "body", "createdAt", "id", "includesCreatedEdit", "isMinimized", "minimizedReason", "reactionGroups", "url", "viewerDidAuthor"];
const GH_LABEL_KEYS = ["color", "description", "id", "name"];

/**
 * What every story store must do the same way. `subject` is called before each test and returns a store that starts without stories,
 * and the login the store writes on its comments. Each case makes its own stories and uses only the numbers it gets back.
 * `texts: false` skips the cases that compare the step texts (the GitHub side needs a jq binary).
 */
export function storyStoreContract(name: string, subject: () => { store: StoryStore; login: string }, o: { texts?: boolean } = {}): void {
  describe(`${name} keeps the story store contract`, () => {
    let store: StoryStore;
    let login = "";
    beforeEach(() => {
      ({ store, login } = subject());
    });
    const make = async (title: string, labels: string[] = []) => (await store.create({ title, body: `body of ${title}`, labels })).number;
    const names = (i: { labels: ({ name?: string } | string)[] }) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

    it("creates a story and reads it back", async () => {
      const made = await store.create({ title: "T one", body: "line\n$(x) `y`", labels: ["a"] });
      expect(made.number).toBeGreaterThanOrEqual(1);
      expect(made.state).toBe("open");
      expect(names(made)).toEqual(["a"]);
      expect(made.html_url).not.toBe("");
      expect(Number.isNaN(Date.parse(made.created_at))).toBe(false);
      const got = await store.get(made.number);
      expect([got?.title, got?.body, got && names(got)]).toEqual(["T one", "line\n$(x) `y`", ["a"]]);
      expect(await store.get(999999)).toBeUndefined();
    });

    it("edits the title and the body, and keeps the title when only the body changes", async () => {
      const n = await make("before");
      await store.edit(n, { title: "after", body: "new body" });
      expect(await store.get(n)).toMatchObject({ title: "after", body: "new body" });
      await store.edit(n, { body: "only body" });
      expect(await store.get(n)).toMatchObject({ title: "after", body: "only body" });
    });

    it("changes labels", async () => {
      const n = await make("labels", ["a"]);
      await store.setLabels(n, "b", ["a"]);
      expect(names((await store.get(n))!)).toEqual(["b"]);
      await store.setLabels(n, undefined, ["b"]);
      expect(names((await store.get(n))!)).toEqual([]);
    });

    it("adds and lists comments", async () => {
      const n = await make("comments");
      expect(typeof (await store.comment(n, "hello there"))).toBe("string");
      expect((await store.comments(n)).map((c) => c.body.trim())).toContain("hello there");
    });

    it("updates the status comment instead of adding another", async () => {
      const n = await make("status");
      const first = await store.upsertStatusComment(n, `one\n${STATUS_MARKER}`, { create: true });
      expect(first.created).toBe(true);
      const second = await store.upsertStatusComment(n, `two\n${STATUS_MARKER}`, { create: true });
      expect(second.changed).toBe(true);
      expect(second.created).toBeUndefined();
      const ours = (await store.comments(n)).filter(isStatusComment);
      expect(ours.map((c) => c.body.trim())).toEqual([`two\n${STATUS_MARKER}`]);
    });

    it("closes and reopens", async () => {
      const n = await make("closing");
      expect((await store.close(n, "completed")).state).toBe("closed");
      expect((await store.get(n))?.state).toBe("closed");
      expect((await store.reopen(n)).state).toBe("open");
      expect((await store.get(n))?.state).toBe("open");
    });

    it("reports states", async () => {
      const a = await make("a");
      const b = await make("b");
      await store.close(b, "completed");
      expect([...(await store.states([a, b]))]).toEqual([[a, "open"], [b, "closed"]]);
      expect(await store.state(a)).toBe("open");
    });

    it("lists stories", async () => {
      const a = await make("list a", ["lab"]);
      const b = await make("list b", ["lab"]);
      await store.close(b, "completed");
      const all = (await store.listAll({ pages: 1 })).issues;
      expect([all.find((i) => i.number === a)?.state, all.find((i) => i.number === b)?.state]).toEqual(["open", "closed"]);
      const open = (await store.listOpen({ pages: 1 })).issues.map((i) => i.number);
      expect(open).toContain(a);
      expect(open).not.toContain(b);
      const page = (await store.listOpenByLabelPages("lab", { fromPage: 1, pages: 1 })).pages.get(1)!;
      expect(page.map((i) => i.number)).toEqual([a]);
    });

    it("lists the newest stories, newest first, and says when the page is not full", async () => {
      const a = await make("newest a");
      const b = await make("newest b");
      const r = await store.listNewestCut();
      expect(r.cut).toBe(false);
      expect(r.issues.map((i) => i.number)).toEqual([b, a]);
      expect((await store.listNewest()).map((i) => i.number)).toEqual([b, a]);
    });

    // The step texts: the same story must give the same text in every store. Only the address and the login differ.
    const skip = o.texts === false;
    const MARKER = "<!-- claude-factory run=r1 -->";
    /** A story with two labels and two comments, the second one a Foundry comment. */
    const shaped = async () => {
      const n = (await store.create({ title: "Shape", body: "first\n--- comment by someone\nlast", labels: ["a", "b"] })).number;
      await store.comment(n, "hello");
      await store.comment(n, `status\n${MARKER}`);
      return { n, url: (await store.get(n))!.html_url };
    };

    it.skipIf(skip)("gives the same ticket text and plain text", async () => {
      const { n, url } = await shaped();
      expect(await store.stepText(n)).toBe(
        `# #${n}: Shape\n${url}\nLabels: a, b\n\nfirst\n> --- comment by someone\nlast\n\n--- comment by ${login}:\nhello\n\n--- comment by ${login} (Foundry):\nstatus\n${MARKER}\n`);
      expect(await store.stepPlainText(n)).toBe(
        `# #${n}: Shape\nLabels: a, b\n\nfirst\n--- comment by someone\nlast\n\n--- comment by ${login}:\nhello\n\n--- comment by ${login}:\nstatus\n${MARKER}\n`);
    });

    it.skipIf(skip)("ends the texts of a story without comments with the body and two line breaks", async () => {
      const n = (await store.create({ title: "Solo", body: "alone", labels: [] })).number;
      const url = (await store.get(n))!.html_url;
      expect(await store.stepText(n)).toBe(`# #${n}: Solo\n${url}\nLabels: \n\nalone\n\n`);
      expect(await store.stepPlainText(n)).toBe(`# #${n}: Solo\nLabels: \n\nalone\n\n`);
      const empty = (await store.create({ title: "Empty", body: "", labels: [] })).number;
      expect(await store.stepText(empty)).toBe(`# #${empty}: Empty\n${(await store.get(empty))!.html_url}\nLabels: \n\n\n\n`);
    });

    it.skipIf(skip)("gives the title, the body, the labels and the authors", async () => {
      const { n } = await shaped();
      expect(await store.stepTitle(n)).toBe("Shape\n");
      expect(await store.stepBody(n)).toBe("first\n--- comment by someone\nlast\n");
      expect(await store.stepLabels(n)).toBe("a\nb\n");
      expect(await store.stepAuthors(n)).toMatch(/^\S* \S*\n$/);
    });

    it.skipIf(skip)("gives JSON with the fields of gh", async () => {
      const { n } = await shaped();
      const issue = JSON.parse(await store.stepIssue(n));
      expect(Object.keys(issue)).toEqual(["body", "number", "title", "updatedAt"]);
      expect([issue.body, issue.number, issue.title]).toEqual(["first\n--- comment by someone\nlast", n, "Shape"]);
      const both = JSON.parse(await store.stepCommentsAndLabels(n));
      expect(Object.keys(both)).toEqual(["comments", "labels"]);
      expect(both.labels.map((l: { name: string }) => l.name)).toEqual(["a", "b"]);
      for (const l of both.labels) expect(Object.keys(l)).toEqual(GH_LABEL_KEYS);
      expect(both.comments.map((c: { body: string }) => c.body)).toEqual(["hello", `status\n${MARKER}`]);
      for (const c of both.comments) {
        expect(Object.keys(c)).toEqual(GH_COMMENT_KEYS);
        expect(c.author).toEqual({ login });
        expect(c.viewerDidAuthor).toBe(true);
        expect(c.url).toMatch(/#issuecomment-\d+$/);
      }
    });

    it.skipIf(skip)("lists the comments and the Foundry comments by their ids", async () => {
      const { n } = await shaped();
      const lines = (await store.stepComments(n)).trimEnd().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((c) => c.body)).toEqual(["hello", `status\n${MARKER}`]);
      for (const c of lines) {
        expect(Object.keys(c)).toEqual(["id", "html_url", "created_at", "updated_at", "body"]);
        expect(c.html_url).toMatch(new RegExp(`#issuecomment-${c.id}$`));
      }
      expect(JSON.parse(await store.stepFoundryComments(n))).toEqual([lines[1].id]);
    });

    it.skipIf(skip)("writes through the steps", async () => {
      const { n } = await shaped();
      expect(await store.stepComment(n, "more")).toMatch(/#issuecomment-\d+\n$/);
      expect(await store.stepCreate({ title: "Made by step", body: "b", labels: [] })).toMatch(/(\d+)\n$/);
      await store.stepClose(n, "not planned");
      expect((await store.get(n))?.state).toBe("closed");
    });
  });
}
