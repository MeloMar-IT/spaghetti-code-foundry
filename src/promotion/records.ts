import { join } from "node:path";
import { z } from "zod";
import { dataHome, StoreError, withAuthLock } from "../auth/store.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import { writeAtomic } from "../engine/policy-store.js";
import { Sha256Schema } from "../evidence/identity.js";
import { COMPONENT_KINDS, type ComponentKind } from "./components.js";
import { folderState, openPromotionsFolder, PROMOTIONS_FOLDER } from "./versions.js";

/**
 * `<home>/promotions/records.json`: the promotions made with `scf promote --report` or the Foundry's web interface. A record
 * names the full component (kind, id, version and hash) and the reports that held. Only `writeRecord` writes it, under the
 * data-folder lock. Reasons are fixed text: they never hold a machine path or file content.
 */

export const RECORDS_FILE = "records.json";
export const MAX_RECORDS_BYTES = 4 << 20;
const WHAT = `${PROMOTIONS_FOLDER}/${RECORDS_FILE}`;

/** A report id is the report's file name without `.json`: `<suite>-<stamp>`. */
export const REPORT_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export interface ReportRef {
  suite: string;
  id: string;
  sha256: string;
}
export interface PromotionEntry {
  kind: ComponentKind;
  id: string;
  version: string;
  sha256: string;
  reportId: string;
  reports: ReportRef[];
  promotedAt: string;
  by: string;
}
export interface RecordBook {
  version: 1;
  records: PromotionEntry[];
}
export type RecordBookRead = { ok: true; book: RecordBook } | { ok: false; reason: string };

const ReportRefSchema = z.object({ suite: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/), id: z.string().regex(REPORT_ID_RE), sha256: Sha256Schema }).strict();
const EntrySchema = z
  .object({
    kind: z.enum(COMPONENT_KINDS),
    id: z.string().regex(/^[\w.-]{1,200}$/),
    version: z.string().min(1).max(64),
    sha256: Sha256Schema,
    reportId: z.string().regex(REPORT_ID_RE),
    reports: z.array(ReportRefSchema).max(50),
    promotedAt: z.iso.datetime(),
    by: z.string().min(1).max(100),
  })
  .strict();
export const RecordBookSchema = z.object({ version: z.literal(1), records: z.array(EntrySchema) }).strict();

type Ref = Pick<PromotionEntry, "kind" | "id" | "version" | "sha256">;
const sameRef = (a: Ref, b: Ref) => a.kind === b.kind && a.id === b.id && a.version === b.version && a.sha256 === b.sha256;

/** Reads the book. A missing folder or file is an empty book; a link, a large or a bad file is a reason. Never writes. */
export function readRecordBook(home = dataHome()): RecordBookRead {
  const empty: RecordBookRead = { ok: true, book: { version: 1, records: [] } };
  const dir = join(home, PROMOTIONS_FOLDER);
  const state = folderState(dir);
  if (state === undefined) return empty;
  if (!state) return { ok: false, reason: `${PROMOTIONS_FOLDER} is a link or not a folder` };
  const read = readPolicyFile(join(dir, RECORDS_FILE), MAX_RECORDS_BYTES);
  if ("problem" in read) {
    if (read.problem === "missing") return empty;
    if (read.problem === "not-file") return { ok: false, reason: `${WHAT} is a link or not a plain file` };
    if (read.problem === "too-large") return { ok: false, reason: `${WHAT} is larger than 4 MiB` };
    return { ok: false, reason: `${WHAT} could not be read` };
  }
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    json = undefined;
  }
  const res = RecordBookSchema.safeParse(json);
  if (!res.success) return { ok: false, reason: `${WHAT} is not valid; it is not changed, fix or restore it` };
  return { ok: true, book: res.data };
}

/** The record of exactly this kind, id, version and hash. */
export const findRecord = (book: RecordBook, ref: Ref): PromotionEntry | undefined => book.records.find((r) => sameRef(r, ref));

export type WriteResult = { ok: true } | { ok: false; reason: string };

/** Adds the record, replacing one of the same kind, id, version and hash. Runs under the lock of the data folder. */
export function writeRecord(entry: PromotionEntry, o: { waitMs?: number } = {}): WriteResult {
  try {
    return withAuthLock(() => {
      const home = dataHome();
      const read = readRecordBook(home);
      if (!read.ok) return read;
      const book: RecordBook = { version: 1, records: [...read.book.records.filter((r) => !sameRef(r, entry)), entry] };
      if (!RecordBookSchema.safeParse(book).success) return { ok: false as const, reason: `${WHAT} would not be valid; nothing was recorded` };
      const text = JSON.stringify(book, null, 2) + "\n";
      if (Buffer.byteLength(text) > MAX_RECORDS_BYTES) return { ok: false as const, reason: `${WHAT} would be larger than 4 MiB; nothing was recorded` };
      const folder = openPromotionsFolder(home);
      if (!folder.ok) return folder;
      writeAtomic(join(folder.dir, RECORDS_FILE), text);
      return { ok: true as const };
    }, o.waitMs);
  } catch (e) {
    if (e instanceof StoreError && e.kind === "locked") return { ok: false, reason: "another scf command holds the data-folder lock; try again" };
    return { ok: false, reason: `${WHAT} could not be written` };
  }
}
