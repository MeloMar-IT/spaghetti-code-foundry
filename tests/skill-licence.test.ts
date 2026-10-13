import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceTree, TreeEntry } from "../src/skills/import-plan.js";
import {
  collectLicenceEvidence, evaluateLicence, identifyLicence, normalizeLicenceText,
  type LicenceEvidence, type LicenceEvidenceFile,
} from "../src/skills/licence.js";
import { LICENCE_FINGERPRINTS, LICENCE_FULL_TEXTS, LICENCE_LIMITS, LICENCE_POLICY, LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { SOURCE_LICENCES } from "../src/skills/sources.js";

// Complete licence texts, written out here (not built from the matching table).
const MIT = `MIT License

Copyright (c) 2024 Example Person

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const ISC = `ISC License

Copyright (c) 2024, Example Person

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;
const BSD_HEAD = `Copyright (c) 2024, Example Person

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
`;
const BSD_3RD = `
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.
`;
const BSD_TAIL = `
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
const BSD2 = BSD_HEAD + BSD_TAIL;
const BSD3 = BSD_HEAD + BSD_3RD + BSD_TAIL;
const templateText = (id: string) => LICENCE_TEMPLATES.find((t) => t.id === id)!.text.replace("{name}", "the copyright holder");
const ZERO_BSD = templateText("0BSD");
const UNLICENSE = templateText("Unlicense");
// The complete Apache-2.0 text, as two published copies: with and without the appendix.
const APACHE = readFileSync("tests/fixtures/licences/apache-2.0.txt", "utf8");
const APACHE_SHORT = readFileSync("tests/fixtures/licences/apache-2.0-short.txt", "utf8");
const GPL = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";
const BUSL = "Business Source License 1.1\nLicensor: Example\n";
const PROPRIETARY = "Proprietary. All rights reserved.\n";

const b = (s: string) => Buffer.from(s);

describe("normalizeLicenceText", () => {
  it("lower-cases and collapses punctuation and white space", () => {
    expect(normalizeLicenceText('  The "Software",\r\n\tAND/OR  ')).toBe("the software and or");
  });
});

describe("identifyLicence", () => {
  it.each([
    ["MIT", MIT],
    ["ISC", ISC],
    ["0BSD", ZERO_BSD],
    ["BSD-2-Clause", BSD2],
    ["BSD-3-Clause", BSD3],
    ["Unlicense", UNLICENSE],
    ["Apache-2.0", APACHE],
    ["Apache-2.0", APACHE_SHORT],
    ["Apache-2.0", APACHE.replace("Copyright {yyyy} {name of copyright owner}", "Copyright 2024 Example Person")],
  ])("identifies %s from a complete text", (id, text) => {
    expect(identifyLicence(b(text)).id).toBe(id);
  });
  it("tells MIT, ISC and 0BSD apart, and BSD-2 and BSD-3", () => {
    const ids = [MIT, ISC, ZERO_BSD, BSD2, BSD3].map((t) => identifyLicence(b(t)).id);
    expect(new Set(ids).size).toBe(5);
  });
  it("does not change with CRLF, odd white space, another owner or no title", () => {
    expect(identifyLicence(b(MIT.replace(/\n/g, "\r\n"))).id).toBe("MIT");
    expect(identifyLicence(b(MIT.replace(/ /g, "  "))).id).toBe("MIT");
    expect(identifyLicence(b(MIT.replace("Example Person", "Someone Else").replace("MIT License\n", ""))).id).toBe("MIT");
  });
  it("names no licence for a title alone, mixed licences or bytes that are not UTF-8", () => {
    expect(identifyLicence(b("MIT License\n")).id).toBeUndefined();
    expect(identifyLicence(b(MIT + "\n" + APACHE)).id).toBeUndefined();
    expect(identifyLicence(new Uint8Array([0xff, 0xfe, 0x41])).id).toBeUndefined();
  });
  it("does not accept a licence with an added restriction or a removed sentence", () => {
    expect(identifyLicence(b(MIT + "\nUse is permitted for educational purposes only.\n")).id).toBeUndefined();
    expect(identifyLicence(b(MIT.replace("sublicense, and/or sell", "sublicense"))).id).toBeUndefined();
    expect(identifyLicence(b(BSD2 + "\nThis software may not be used in military projects.\n")).id).toBeUndefined();
    expect(identifyLicence(b(BSD_HEAD)).id).toBeUndefined();
  });
  it("does not accept an owner line that carries a restriction", () => {
    const sentence = "Copyright (c) 2026 Example. Use is permitted for educational purposes only.";
    expect(identifyLicence(b(MIT + "\n" + sentence + "\n")).id).toBeUndefined();
    expect(identifyLicence(b(sentence + "\n" + MIT)).id).toBeUndefined();
    expect(identifyLicence(b(MIT.replace("Copyright (c) 2024 Example Person", sentence))).id).toBeUndefined();
    expect(identifyLicence(b(BSD2.replace("Copyright (c) 2024, Example Person", sentence))).id).toBeUndefined();
    expect(identifyLicence(b(MIT.replace("Example Person", "Example Person, all rights reserved"))).id).toBe("MIT");
  });
  it("does not accept a long licence that is cut short, padded, restricted or changed", () => {
    const filler = "\nNo permission is granted.".repeat(500);
    expect(identifyLicence(b("Apache License\nVersion 2.0, January 2004\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\nEND OF TERMS AND CONDITIONS")).id).toBeUndefined();
    expect(identifyLicence(b("Apache License\nVersion 2.0, January 2004\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION" + filler + "\nEND OF TERMS AND CONDITIONS\n")).id).toBeUndefined();
    expect(identifyLicence(b(APACHE + "\nUse is permitted for educational purposes only.\n")).id).toBeUndefined();
    expect(identifyLicence(b(APACHE_SHORT + "\nCopyright (c) 2026 Example. Use is permitted for educational purposes only.\n")).id).toBeUndefined();
    expect(identifyLicence(b(APACHE.replace("grants to You a perpetual", "grants to You a revocable"))).id).toBeUndefined();
    expect(identifyLicence(b(APACHE.replace("Copyright {yyyy} {name of copyright owner}", "Copyright {yyyy} {name of copyright owner}\nUse is permitted for educational purposes only."))).id).toBeUndefined();
  });
  it("does not recognise CC0 or CC-BY by a heading (their complete texts are not known)", () => {
    expect(identifyLicence(b("CC0 1.0 Universal\n" + "No permission is granted.\n".repeat(500))).id).toBeUndefined();
    expect(identifyLicence(b("Creative Commons Attribution 4.0 International\n" + "No permission is granted.\n".repeat(900))).id).toBeUndefined();
  });
  it("reports a source-available term", () => {
    const r = identifyLicence(b(MIT + "\n\"Commons Clause\" License Condition v1.0\nYou may not Sell the Software.\n"));
    expect(r.id).toBeUndefined();
    expect(r.markers).toContain("commons clause");
    expect(identifyLicence(b(APACHE + "\nNon-commercial use only.\n")).markers).toContain("non commercial");
  });
  it("identifies the review and rejected families", () => {
    expect(identifyLicence(b(GPL)).id).toBe("GPL");
    expect(identifyLicence(b(BUSL)).id).toBe("BUSL-1.1");
  });
});

describe("policy table", () => {
  it("accepts every SOURCE_LICENCES entry by policy; all but CC0-1.0 and CC-BY-4.0 can be identified", () => {
    const unknownText = ["CC0-1.0", "CC-BY-4.0"];
    for (const id of SOURCE_LICENCES) {
      expect(LICENCE_POLICY[id]).toBe("allowed");
      const known = LICENCE_TEMPLATES.some((t) => t.id === id) || LICENCE_FULL_TEXTS.some((f) => f.id === id) || LICENCE_FINGERPRINTS.some((f) => f.id === id);
      expect(known).toBe(!unknownText.includes(id));
    }
  });
});

type Spec = string | { kind: TreeEntry["kind"]; size?: number };
function tree(files: Record<string, Spec>) {
  const content = new Map<string, Uint8Array>();
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => {
    if (typeof v === "string") {
      content.set(path, b(v));
      return { path, kind: "file" as const, size: b(v).byteLength, id: "id:" + path };
    }
    return { path, kind: v.kind, ...(v.size === undefined ? {} : { size: v.size }), id: "id:" + path };
  });
  const reads: string[][] = [];
  const t: SourceTree & { reads: string[][]; lists: string[] } = {
    reads,
    lists: [],
    list: (p) => {
      t.lists.push(p);
      return all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/"));
    },
    read: (entries) => {
      reads.push(entries.map((e) => e.path));
      return entries.map((e) => content.get(e.path) ?? new Uint8Array(e.size ?? 0));
    },
  };
  return t;
}
const ORIGIN = { repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };

describe("collectLicenceEvidence", () => {
  it("picks licence and notice files in, below and above a root, from one listing", () => {
    const t = tree({ LICENSE: MIT, "skills/a/SKILL.md": "x", "skills/a/LICENSE.txt": MIT, "skills/a/NOTICE": "n", "skills/NOTICE": "n2", "skills/a/deep/COPYING": GPL });
    const ev = collectLicenceEvidence(ORIGIN, ["skills/a"], t);
    expect(ev.files.map((f) => `${f.kind}:${f.path}:${f.dir}`)).toEqual([
      "licence:LICENSE:.",
      "licence:skills/a/LICENSE.txt:skills/a",
      "licence:skills/a/deep/COPYING:skills/a/deep",
      "notice:skills/a/NOTICE:skills/a",
      "notice:skills/NOTICE:skills",
    ].sort((x, y) => (x.split(":")[1]! < y.split(":")[1]! ? -1 : 1)));
    expect(t.lists).toEqual(["."]);
    expect(ev.repositoryKey).toBe(ORIGIN.repositoryKey);
    expect(ev.commit).toBe(ORIGIN.commit);
  });
  it("ignores other folders and files that are not licence files", () => {
    const t = tree({ "other/LICENSE": MIT, "skills/a/license.py": "x", "skills/a/SKILL.md": "x", "skills/b/LICENSE": MIT });
    expect(collectLicenceEvidence(ORIGIN, ["skills/a"], t).files).toEqual([]);
  });
  it("marks a link, a submodule and an oversize file and does not read them", () => {
    const t = tree({
      "skills/a/LICENSE": { kind: "symlink" },
      "skills/a/COPYING": { kind: "submodule" },
      "skills/a/LICENSE.md": { kind: "file", size: LICENCE_LIMITS.fileBytes + 1 },
      "skills/a/NOTICE": { kind: "file" },
      "skills/a/AUTHORS": "Ann\n",
    });
    const ev = collectLicenceEvidence(ORIGIN, ["skills/a"], t);
    const by = Object.fromEntries(ev.files.map((f) => [f.path, f]));
    expect(by["skills/a/LICENSE"]).toMatchObject({ problem: "a symbolic link" });
    expect(by["skills/a/COPYING"]).toMatchObject({ problem: "a submodule" });
    expect(by["skills/a/LICENSE.md"]!.problem).toContain("is larger than");
    expect(by["skills/a/NOTICE"]!.problem).toBe("has no size");
    expect(by["skills/a/LICENSE"]!.content).toBeUndefined();
    expect(by["skills/a/AUTHORS"]!.content).toBeDefined();
    expect(t.reads).toEqual([["skills/a/AUTHORS"]]);
  });
  it("throws above the file limit", () => {
    const files: Record<string, Spec> = {};
    for (let i = 0; i <= LICENCE_LIMITS.files; i++) files[`skills/a/d${i}/LICENSE`] = "x";
    expect(() => collectLicenceEvidence(ORIGIN, ["skills/a"], tree(files))).toThrowError(expect.objectContaining({ code: "too-many-entries" }));
  });
  it("throws above the total size limit", () => {
    const files: Record<string, Spec> = {};
    for (let i = 0; i < 17; i++) files[`skills/a/d${i}/LICENSE`] = { kind: "file", size: LICENCE_LIMITS.fileBytes };
    expect(() => collectLicenceEvidence(ORIGIN, ["skills/a"], tree(files))).toThrowError(expect.objectContaining({ code: "too-large" }));
  });
  it("marks content of the wrong length", () => {
    const t = tree({ "skills/a/LICENSE": { kind: "file", size: 5 } });
    t.read = () => [new Uint8Array(2)];
    expect(collectLicenceEvidence(ORIGIN, ["skills/a"], t).files[0]!.problem).toBe("content does not match the listing");
  });
});

const file = (path: string, text: string | undefined, over: Partial<LicenceEvidenceFile> = {}): LicenceEvidenceFile => ({
  path,
  dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".",
  kind: /(?:notice|authors)/i.test(path.slice(path.lastIndexOf("/") + 1)) ? "notice" : "licence",
  ...(text === undefined ? {} : { content: b(text) }),
  ...over,
});
const ev = (...files: LicenceEvidenceFile[]): LicenceEvidence => ({ ...ORIGIN, files });
const judge = (files: LicenceEvidenceFile[], over: { declared?: string; allow?: string[]; root?: string } = {}) =>
  evaluateLicence({ root: over.root ?? "skills/a", allow: over.allow ?? ["MIT", "Apache-2.0"], evidence: ev(...files), ...(over.declared === undefined ? {} : { declared: over.declared }) });

describe("evaluateLicence", () => {
  it("accepts a repository-wide MIT licence", () => {
    const v = judge([file("LICENSE", MIT)]);
    expect(v).toMatchObject({ status: "allowed", governedBy: ".", licences: ["MIT"], reasons: [] });
    expect(v.licenceFiles[0]).toMatchObject({ path: "LICENSE", bytes: b(MIT).byteLength, licence: "MIT" });
  });
  it("lets the nearest folder govern", () => {
    expect(judge([file("LICENSE", MIT), file("skills/a/LICENSE", APACHE)])).toMatchObject({ status: "allowed", governedBy: "skills/a", licences: ["Apache-2.0"] });
    expect(judge([file("LICENSE", PROPRIETARY), file("skills/a/LICENSE", MIT)])).toMatchObject({ status: "allowed", governedBy: "skills/a" });
    expect(judge([file("LICENSE", MIT), file("skills/LICENSE", BUSL)])).toMatchObject({ status: "rejected", governedBy: "skills" });
  });
  it("needs a licence file", () => {
    expect(judge([])).toMatchObject({ status: "missing" });
    expect(judge([], { declared: "MIT" }).status).toBe("missing");
    expect(judge([file("other/LICENSE", MIT)]).status).toBe("missing");
  });
  it("is ambiguous for unknown text, a link, or a file that cannot be read", () => {
    expect(judge([file("LICENSE", "Do what you like.\n")]).status).toBe("ambiguous");
    expect(judge([file("LICENSE", undefined, { problem: "a symbolic link" })]).status).toBe("ambiguous");
    expect(judge([file("LICENSE", MIT + "\nUse is permitted for educational purposes only.\n")]).status).toBe("ambiguous");
  });
  it("checks the declared licence of SKILL.md", () => {
    const mit = [file("LICENSE", MIT)];
    expect(judge(mit, { declared: "MIT" }).status).toBe("allowed");
    expect(judge(mit, { declared: "mit" }).status).toBe("allowed");
    expect(judge(mit, { declared: "Apache-2.0" })).toMatchObject({ status: "ambiguous", reasons: ["SKILL.md names Apache-2.0, the licence files do not"] });
    expect(judge(mit, { declared: "GPL-3.0-only" }).status).toBe("ambiguous");
    expect(judge(mit, { declared: "UNLICENSED" }).status).toBe("ambiguous");
    expect(judge(mit, { declared: "Free for everyone" }).status).toBe("ambiguous");
    expect(judge(mit, { declared: "See LICENSE. Use is permitted for educational purposes only." }).status).toBe("ambiguous");
    expect(judge(mit, { declared: "MIT. Use is permitted for educational purposes only." }).status).toBe("ambiguous");
    expect(judge(mit, { declared: "See LICENSE" }).status).toBe("allowed");
    expect(judge(mit, { declared: "See somewhere else" }).status).toBe("ambiguous");
    expect(judge(mit, { declared: "Proprietary. LICENSE.txt has complete terms" }).status).toBe("rejected");
    const txt = [file("skills/a/LICENSE.txt", MIT)];
    expect(judge(txt, { declared: "Complete terms in LICENSE.txt" })).toMatchObject({ status: "allowed", declared: "Complete terms in LICENSE.txt" });
    expect(judge(txt, { declared: "Complete terms in LICENSE.md" }).status).toBe("ambiguous");
    expect(judge([file("LICENSE-MIT", MIT), file("LICENSE-APACHE", APACHE)], { declared: "MIT OR Apache-2.0" }).status).toBe("allowed");
  });
  it("applies the policy", () => {
    expect(judge([file("LICENSE", BUSL)]).status).toBe("rejected");
    expect(judge([file("LICENSE", GPL)])).toMatchObject({ status: "review", reasons: ["LICENSE: GPL needs review"] });
    expect(judge([file("LICENSE", MIT)], { allow: ["Apache-2.0"] })).toMatchObject({ status: "rejected", reasons: ["LICENSE: MIT is not in licence.allow of the source"] });
    expect(judge([file("LICENSE", MIT + "\nCommons Clause License Condition v1.0\n")])).toMatchObject({ status: "rejected" });
  });
  it("accepts two allowed licence files", () => {
    expect(judge([file("LICENSE-MIT", MIT), file("LICENSE-APACHE", APACHE)])).toMatchObject({ status: "allowed", licences: ["Apache-2.0", "MIT"] });
  });
  it("judges a licence file inside the skill too", () => {
    expect(judge([file("LICENSE", MIT), file("skills/a/scripts/vendor/LICENSE", GPL)]).status).toBe("review");
  });
  it("uses the order missing > ambiguous > rejected > review", () => {
    expect(judge([file("LICENSE", GPL), file("skills/a/x/LICENSE", BUSL)]).status).toBe("rejected");
    expect(judge([file("LICENSE", GPL), file("skills/a/x/LICENSE", BUSL), file("skills/a/y/LICENSE", "???")]).status).toBe("ambiguous");
    expect(judge([file("skills/a/x/LICENSE", MIT)]).status).toBe("missing");
  });
  it("never shows file content, and hides a credential-like path", () => {
    const v = judge([file("LICENSE", "SECRET-PHRASE-" + "x".repeat(10)), file("skills/a/ghp_" + "a1B2c3D4e5".repeat(4) + "/LICENSE", BUSL)]);
    expect(JSON.stringify(v.reasons)).not.toContain("SECRET-PHRASE");
    expect(v.reasons.join(" ")).toContain("(hidden)");
  });
  it("keeps notice files of every folder above the skill, and refuses one that cannot be kept", () => {
    const notice = judge([file("LICENSE", MIT), file("skills/NOTICE", "Copyright (c) 2020 Ann\n"), file("NOTICE", "n\n"), file("skills/a/AUTHORS", "Bob\n"), file("skills/b/NOTICE", "other\n")]);
    expect(notice.status).toBe("allowed");
    expect(notice.attribution.map((a) => a.path)).toEqual(["LICENSE", "NOTICE", "skills/NOTICE", "skills/a/AUTHORS"]);
    expect(judge([file("LICENSE", MIT), file("skills/NOTICE", undefined, { problem: "is larger than 262144 bytes" })])).toMatchObject({ status: "ambiguous" });
    expect(judge([file("LICENSE", MIT), file("NOTICE", undefined, { problem: "a symbolic link" })]).status).toBe("ambiguous");
  });
  it("takes copyright lines as the author notice, bounded", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `Copyright (c) 20${10 + i} Person ${i}`).join("\n");
    const v = judge([file("LICENSE", MIT), file("NOTICE", lines + "\n" + "Copyright " + "y".repeat(500) + "\nNot a notice line\n")]);
    expect(v.authorNotice).toHaveLength(LICENCE_LIMITS.noticeLines);
    expect(v.authorNotice[0]).toBe("Copyright (c) 2024 Example Person");
    expect(v.authorNotice.every((l) => l.length <= LICENCE_LIMITS.noticeChars + 1)).toBe(true);
    expect(v.authorNotice).not.toContain("Not a notice line");
  });
});
