import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { REFINEMENT_SOURCE } from "../src/auth/run-owner.js";
import { INPUT_FILES_MISSING, copyInputFiles, removeRunPictureCopies } from "../src/engine/workspace.js";
import { askArchitect, architectReason, pictureWorkdirs, pictureWorkdirsOf, settleFinished, type ArchitectDeps } from "../src/refinement/architect.js";
import {
  PICTURE_MAX_BYTES,
  PictureError,
  pictureFiles,
  pictureType,
  picturePath,
  picturesDir,
  picturesText,
  readPictures,
  removePictures,
  writePictures,
} from "../src/refinement/pictures.js";
import { createSession, dropSession, getSession, purgeDropped, refinementsPath, removeRefinementsLocked, restoreSession, setArchitectRun } from "../src/refinement/store.js";
import { withAuthLock } from "../src/auth/store.js";
import { questionOf, suggestOf, talkText } from "../src/refinement/talk-text.js";
import { emptyTalk } from "../src/refinement/talk.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name } as never;
const owner = { id: ANN, admin: false };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")]);
const b64 = (b: Buffer) => b.toString("base64");

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "pictures-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  chmodSync(home, 0o700);
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("pictureType", () => {
  it("knows PNG, JPEG and WebP by their first bytes", () => {
    expect(pictureType(PNG)).toBe("png");
    expect(pictureType(JPG)).toBe("jpeg");
    expect(pictureType(WEBP)).toBe("webp");
  });
  it("refuses everything else", () => {
    for (const b of [Buffer.from("GIF89a..."), Buffer.from("<svg xmlns='x'/>"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]), PNG.subarray(0, 7), Buffer.alloc(0)]) {
      expect(pictureType(b)).toBeUndefined();
    }
  });
});

describe("readPictures", () => {
  it("accepts up to 5 valid pictures", () => {
    const r = readPictures([b64(PNG), b64(JPG), b64(WEBP), b64(PNG), b64(JPG)]);
    expect(r.map((p) => p.type)).toEqual(["png", "jpeg", "webp", "png", "jpeg"]);
    expect(r[0]!.data.equals(PNG)).toBe(true);
  });
  const refused: [string, unknown, RegExp][] = [
    ["not a list", "x", /must be a list/],
    ["a sixth", Array(6).fill(b64(PNG)), /at most 5/],
    ["too large", [b64(Buffer.concat([PNG, Buffer.alloc(PICTURE_MAX_BYTES)]))], /picture 1 is larger than 5 MB/],
    ["empty string", [b64(PNG), ""], /picture 2 is empty/],
    ["bad base64", ["!!!!"], /picture 1 could not be read/],
    ["bad length", ["abc"], /picture 1 could not be read/],
    ["a number", [5], /picture 1 is not a file/],
    ["an object", [{}], /not a file/],
    ["null", [null], /not a file/],
    ["gif", [b64(Buffer.from("GIF89a123"))], /not a PNG, JPEG or WebP/],
    ["svg", [b64(Buffer.from("<svg></svg>"))], /not a PNG, JPEG or WebP/],
    ["a data URL", [`data:image/png;base64,${b64(PNG)}`], /could not be read/],
  ];
  for (const [name, input, message] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => readPictures(input)).toThrow(PictureError);
      expect(() => readPictures(input)).toThrow(message);
    });
  }
  it("accepts exactly 5 MB", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(PICTURE_MAX_BYTES - PNG.length)]);
    expect(readPictures([b64(big)])[0]!.data.length).toBe(PICTURE_MAX_BYTES);
  });
});

describe("files", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  it("writes 1.png, 2.jpg, 3.webp and names them for a run", () => {
    writePictures(id, readPictures([b64(PNG), b64(JPG), b64(WEBP)]));
    expect(readFileSync(picturePath(id, 2, "jpeg")).equals(JPG)).toBe(true);
    expect(pictureFiles({ id, pictures: [{ type: "png", size: 1 }, { type: "jpeg", size: 1 }, { type: "webp", size: 1 }] }).map((f) => f.name)).toEqual(["pictures/1.png", "pictures/2.jpg", "pictures/3.webp"]);
    removePictures(id);
    expect(existsSync(picturesDir(id))).toBe(false);
    expect(() => removePictures(id)).not.toThrow();
  });
  it("throws on an id that is not a uuid", () => {
    expect(() => picturesDir("../x")).toThrow();
    expect(() => picturePath(id, 6, "png")).toThrow();
  });
  it("names the files in the task", () => {
    expect(picturesText(["pictures/1.png"])).toMatch(/^## Pictures\nThe person added 1 picture to this request\..*pictures\/1\.png/);
  });
});

describe("the store", () => {
  const make = (pictures = [b64(PNG), b64(JPG)]) => createSession(ANN, { repo: "acme/app", idea: "Add a thing", changeRequest: true, pictures: readPictures(pictures) }, OK);

  it("writes the files and keeps only type and size", () => {
    const s = make();
    expect(s.pictures).toEqual([{ type: "png", size: PNG.length }, { type: "jpeg", size: JPG.length }]);
    expect(readFileSync(picturePath(s.id, 1, "png")).equals(PNG)).toBe(true);
    expect(readFileSync(refinementsPath(), "utf8")).not.toContain(b64(PNG));
  });

  it("refuses pictures on a session that is not a change request", () => {
    expect(() => createSession(ANN, { repo: "acme/app", idea: "x", pictures: readPictures([b64(PNG)]) }, OK)).toThrow();
    expect(existsSync(join(home, "change-pictures"))).toBe(false);
  });

  it("leaves no folder when the save fails", () => {
    if (process.getuid?.() === 0) return;
    mkdirSync(join(home, "change-pictures"));
    writeFileSync(join(home, "refinements.json"), JSON.stringify({ version: 1, sessions: [] }));
    chmodSync(join(home, "refinements.json"), 0o400);
    chmodSync(home, 0o500);
    expect(() => make()).toThrow();
    chmodSync(home, 0o700);
    expect(existsSync(join(home, "change-pictures"))).toBe(true);
    expect(lstatSync(join(home, "change-pictures")).isDirectory()).toBe(true);
    expect(() => picturesDir("x")).toThrow();
    expect(readFileSync(join(home, "refinements.json"), "utf8")).toContain('"sessions":[]');
    expect(existsSync(join(home, "change-pictures")) && readdirNames(join(home, "change-pictures"))).toEqual([]);
  });

  it("drops the files and the field when the request is dropped, and a restore has none", () => {
    const s = make();
    const dropped = dropSession(owner, s.id);
    expect(dropped.pictures).toBeUndefined();
    expect(existsSync(picturesDir(s.id))).toBe(false);
    expect(restoreSession(owner, s.id).pictures).toBeUndefined();
  });

  it("keeps files and metadata when the save of a drop fails", () => {
    if (process.getuid?.() === 0) return;
    const s = make();
    chmodSync(home, 0o500);
    expect(() => dropSession(owner, s.id)).toThrow();
    chmodSync(home, 0o700);
    expect(existsSync(picturesDir(s.id))).toBe(true);
    expect(getSession(s.id)!.pictures).toHaveLength(2);
  });

  it("removes the folders when the account's sessions go", () => {
    const s = make();
    withAuthLock(() => removeRefinementsLocked(ANN));
    expect(existsSync(picturesDir(s.id))).toBe(false);
  });

  it("purges expired sessions and sweeps orphan folders", () => {
    const s = make();
    dropSession(owner, s.id);
    const orphan = "33333333-3333-4333-8333-333333333333";
    writePictures(orphan, readPictures([b64(PNG)]));
    const live = make();
    expect(purgeDropped({ now: () => new Date(Date.now() + 31 * 86_400_000) })).toBe(1);
    expect(existsSync(picturesDir(orphan))).toBe(false);
    expect(existsSync(picturesDir(live.id))).toBe(true);
  });
});

function readdirNames(dir: string): string[] {
  return require_readdir(dir);
}
import { readdirSync } from "node:fs";
const require_readdir = (d: string) => readdirSync(d);

describe("input files of a run", () => {
  let dir: string;
  let from: string;
  beforeEach(() => {
    dir = join(home, "wd");
    mkdirSync(dir);
    from = join(home, "src.png");
    writeFileSync(from, PNG);
  });
  it("copies a file to pictures/1.png", () => {
    copyInputFiles(dir, [{ name: "pictures/1.png", from }]);
    expect(readFileSync(join(dir, "pictures", "1.png")).equals(PNG)).toBe(true);
  });
  it("refuses bad names and sources with a fixed reason", () => {
    const link = join(home, "link.png");
    symlinkSync(from, link);
    for (const f of [{ name: "../x.png", from }, { name: "a/b/c.png", from }, { name: "pictures/1.png", from: "rel.png" }, { name: "pictures/1.png", from: join(home, "none.png") }, { name: "pictures/1.png", from: link }]) {
      expect(() => copyInputFiles(dir, [f])).toThrow(INPUT_FILES_MISSING);
    }
  });
  it("removes the copy of a workdir that exists and skips one that does not", () => {
    copyInputFiles(dir, [{ name: "pictures/1.png", from }]);
    removeRunPictureCopies([dir, join(home, "gone")]);
    expect(existsSync(join(dir, "pictures"))).toBe(false);
  });
  it("finds the copies of every run of a request, an understand run and an earlier attempt too, and leaves out a run still going", () => {
    const s = createSession(ANN, { repo: "acme/app", idea: "Add a thing", changeRequest: true, pictures: readPictures([b64(PNG)]) }, OK);
    setArchitectRun(owner, s.id, "last");
    const folders: Record<string, string> = {};
    for (const id of ["first", "understand", "last", "live"]) {
      folders[id] = join(home, id);
      copyInputFiles(folders[id]!, [{ name: "pictures/1.png", from }]);
    }
    const source = REFINEMENT_SOURCE + s.id;
    const briefs = [
      { runId: "first", source },
      { runId: "understand", source },
      { runId: "last", source },
      { runId: "live", source },
      { runId: "unrelated", source: REFINEMENT_SOURCE + "00000000-0000-4000-8000-000000000000" },
    ];
    const scheduler = {
      briefs: () => briefs,
      isActive: (id: string) => id === "live",
      isQueued: () => false,
      get: (id: string) => ({ runId: id, workdir: folders[id] }),
    };
    const deps = { scheduler, repo: home } as unknown as ArchitectDeps;
    const dirs = pictureWorkdirs(deps, [s]);
    expect(dirs.sort()).toEqual([folders.first, folders.last, folders.understand].sort());
    expect(pictureWorkdirsOf(deps, ANN).sort()).toEqual(dirs.sort());
    removeRunPictureCopies(dirs);
    for (const id of ["first", "understand", "last"]) expect(existsSync(join(folders[id]!, "pictures"))).toBe(false);
    expect(existsSync(join(folders.live!, "pictures", "1.png"))).toBe(true);
  });

  it("removes the copy of a run when it ends: kept while the session has pictures, removed once it is dropped", () => {
    const s = createSession(ANN, { repo: "acme/app", idea: "Add a thing", changeRequest: true, pictures: readPictures([b64(PNG)]) }, OK);
    const folder = join(home, "ended");
    copyInputFiles(folder, [{ name: "pictures/1.png", from }]);
    const run = { runId: "r9", source: REFINEMENT_SOURCE + s.id, status: "cancelled", workdir: folder };
    const scheduler = { briefs: () => [], isActive: () => false, isQueued: () => false, cancel: () => false, get: () => undefined, queue: () => ({ pending: [], active: [] }), submit: () => "x" };
    const deps = { scheduler, repo: home, log: () => undefined } as unknown as ArchitectDeps;
    settleFinished(deps, run as never);
    expect(existsSync(join(folder, "pictures", "1.png"))).toBe(true);
    dropSession(owner, s.id);
    settleFinished(deps, run as never);
    expect(existsSync(join(folder, "pictures"))).toBe(false);
  });
});

describe("the architect", () => {
  beforeEach(() => void addRepo(ANN, "acme/app", { ownerOk: () => true }));
  const stub = () => {
    const submitted: any[] = [];
    const scheduler = { submit: (job: any) => (submitted.push(job), `new-${submitted.length}`), cancel: () => false, get: () => undefined, isActive: () => false, isQueued: () => false, briefs: () => [], queue: () => ({ pending: [], active: [] }) };
    return { submitted, deps: { scheduler, repo: home } as unknown as ArchitectDeps };
  };

  it("gives a brief the files and names them in the task", () => {
    const s = createSession(ANN, { repo: "acme/app", idea: "Add a thing", changeRequest: true, pictures: readPictures([b64(PNG), b64(JPG)]) }, OK);
    const st = stub();
    askArchitect(st.deps, owner, s.id, { kind: "brief" });
    const job = st.submitted[0];
    expect(job.files.map((f: any) => f.name)).toEqual(["pictures/1.png", "pictures/2.jpg"]);
    expect(job.task.startsWith("Add a thing")).toBe(true);
    expect(job.task).toContain("## Pictures");
    expect(job.task).toContain("pictures/1.png, pictures/2.jpg");
  });

  it("gives a request without pictures the same job as before", () => {
    const s = createSession(ANN, { repo: "acme/app", idea: "Add a thing", changeRequest: true }, OK);
    const st = stub();
    askArchitect(st.deps, owner, s.id, { kind: "brief" });
    expect(st.submitted[0].files).toBeUndefined();
    expect(st.submitted[0].task).toBe("Add a thing");
  });

  it("keeps the question last, so questionOf reads the same question with and without pictures", () => {
    const plain = talkText({ kind: "question", idea: "Add a thing", brief: "A brief", talk: emptyTalk(), rejected: [], question: "Why is this?" });
    expect(questionOf(plain)).toBe("Why is this?");
    const at = plain.lastIndexOf("\n\n## The question of the person (");
    const withPictures = `${plain.slice(0, at)}\n\n${picturesText(["pictures/1.png"])}${plain.slice(at)}`;
    expect(questionOf(withPictures)).toBe("Why is this?");
    expect(suggestOf).toBeTypeOf("function");
  });

  it("explains a run that lost its files", () => {
    expect(architectReason({ status: "failed", reason: INPUT_FILES_MISSING })).toBe("The pictures of the request could not be found");
  });
});
