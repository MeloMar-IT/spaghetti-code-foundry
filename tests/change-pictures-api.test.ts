import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRepoReady } from "../src/auth/repos.js";
import { openWorld, type World } from "./helpers/refinement-world.js";

/* Pictures on a change request (#835), through the API with the fake claude. */
/* eslint-disable @typescript-eslint/no-explicit-any */
let w: World;
const ENV = ["FAKE_SIMPLE_ROUND", "FAKE_UNDERSTAND", "FAKE_PICTURES_SEEN"];
const NO_QUESTIONS = JSON.stringify({ questions: [], proposals: [], done: "All clear." });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg body")]);
const pics = (...b: Buffer[]) => b.map((x) => x.toString("base64"));
const hex4 = (b: Buffer) => b.subarray(0, 4).toString("hex");

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  w = await openWorld("change-pictures");
  setRepoReady(w.annRepo().id, { items: [{ id: "out-of-scope", text: "it says what is out of scope" }] });
  process.env.FAKE_PICTURES_SEEN = join(w.tmp, "seen.txt");
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await w.close();
});

const post = (path: string, body: unknown = {}, who = w.ann) => w.call(who, "POST", `/api/changes${path}`, body);
const read = async (id: string) => (await w.call(w.ann, "GET", `/api/changes/${id}`)).json();
async function until(id: string, state: string): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const v = await read(id);
    if (v.state === state) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never ${state}: ${JSON.stringify(await read(id))}`);
}
const seen = () => (existsSync(process.env.FAKE_PICTURES_SEEN!) ? readFileSync(process.env.FAKE_PICTURES_SEEN!, "utf8").trim().split("\n") : []);
const folder = (id: string) => join(w.tmp, "home", "change-pictures", id);
const raw = (id: string, n: string, who = w.ann) => fetch(`${w.base}/api/changes/${id}/pictures/${n}`, { headers: who.headers("GET") });

describe("pictures on a change request", () => {
  it("stores them, shows them to the architect in every run, and serves them to the owner only", async () => {
    const r = await post("", { repo: "acme/app", text: "Make it look like this", pictures: pics(PNG, JPG) });
    expect(r.status).toBe(202);
    const id = r.json().id as string;
    expect(r.text).not.toContain(PNG.toString("base64"));
    await until(id, "questions");
    const both = `1.png:${PNG.length}:${hex4(PNG)} 2.jpg:${JPG.length}:${hex4(JPG)}`;
    expect(seen().length).toBeGreaterThanOrEqual(2); // the brief and the round
    for (const line of seen()) expect(line.endsWith(both), line).toBe(true);

    const got = await raw(id, "1");
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await raw(id, "2")).headers.get("content-type")).toBe("image/jpeg");
    expect((await raw(id, "3")).status).toBe(404);
    expect((await raw(id, "x")).status).toBe(404);
    expect((await raw(id, "1", w.bob)).status).toBe(404);
    expect((await raw(id, "1", w.admin)).status).toBe(403);

    // dropping removes the files
    expect(existsSync(folder(id))).toBe(true);
    expect((await w.call(w.ann, "POST", `/api/refinement/${id}/drop`, {})).status).toBe(200);
    expect(existsSync(folder(id))).toBe(false);
    expect((await raw(id, "1")).status).toBe(404);
  });

  it("gives a retried run the pictures again", async () => {
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [] });
    const id = (await post("", { repo: "acme/app", text: "x", pictures: pics(PNG) })).json().id as string;
    await until(id, "stuck");
    const before = seen().length;
    delete process.env.FAKE_UNDERSTAND;
    expect((await post(`/${id}/retry`)).status).toBe(202);
    await until(id, "cards");
    const after = seen().slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const line of after) expect(line.endsWith(`1.png:${PNG.length}:${hex4(PNG)}`), line).toBe(true);
  });

  it("starts a request without pictures as before", async () => {
    const id = (await post("", { repo: "acme/app", text: "x" })).json().id as string;
    await until(id, "questions");
    expect(seen().every((l) => l.endsWith("| none"))).toBe(true);
    expect((await raw(id, "1")).status).toBe(404);
  });

  it("refuses bad pictures with a plain message and makes no request", async () => {
    const png = PNG.toString("base64");
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString("base64");
    const cases: unknown[] = [Array(6).fill(png), [big], [""], [Buffer.from("<svg></svg>").toString("base64")], [Buffer.from("GIF89a....").toString("base64")], [Buffer.from("just text").toString("base64")], [1], png, {}];
    for (const pictures of cases) {
      const r = await post("", { repo: "acme/app", text: "x", pictures });
      expect(r.status, JSON.stringify(pictures).slice(0, 40)).toBe(400);
      expect(r.error()).toMatch(/picture/);
    }
    expect((await post("", { repo: "acme/app", text: "x", name: "a", pictures: pics(PNG) })).status).toBe(400);
    expect((await w.call(w.ann, "GET", "/api/changes?repo=acme/app")).json().changes).toEqual([]);
    const dir = join(w.tmp, "home", "change-pictures");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("limits the body of POST changes to 36 MiB and of every other route to 1 MB", async () => {
    const huge = await post("", { repo: "acme/app", text: "x", pictures: ["A".repeat(37 * 1024 * 1024)] });
    expect(huge.status).toBe(413);
    const id = (await post("", { repo: "acme/app", text: "x" })).json().id as string;
    expect((await post(`/${id}/answers`, { answers: [], pad: "x".repeat(1_100_000) })).status).toBe(413);
  });
});
