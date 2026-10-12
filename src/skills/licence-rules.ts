import { SOURCE_LICENCES } from "./sources.js";

// Data for licence.ts: policy, file names, limits and the texts a licence file is recognised by. No logic except
// `normalizeLicenceText`, which the table needs to be written in its own form.

export type LicencePolicy = "allowed" | "review" | "rejected";

const policy = (ids: readonly string[], p: LicencePolicy): [string, LicencePolicy][] => ids.map((id) => [id, p]);
export const LICENCE_POLICY: Readonly<Record<string, LicencePolicy>> = Object.freeze(
  Object.fromEntries([
    ...policy(SOURCE_LICENCES, "allowed"),
    ...policy(["MPL-2.0", "EPL-2.0", "LGPL", "GPL", "AGPL", "CC-BY-SA-4.0"], "review"),
    ...policy(["BUSL-1.1", "SSPL-1.0", "Elastic-2.0", "PolyForm", "Commons-Clause", "CC-BY-NC", "CC-BY-ND"], "rejected"),
  ]),
);

export const LICENCE_FILE_RE = /^(?:licen[cs]e|copying|unlicense)(?:[-_][a-z0-9+-]+(?:\.[0-9]+)*)?(?:\.(?:txt|md|rst))?$/i;
export const NOTICE_FILE_RE = /^(?:notice|authors|copyright|attribution|third[-_]?party[-_]?notices)(?:\.(?:txt|md|rst))?$/i;
export const LICENCE_LIMITS = { fileBytes: 262144, files: 200, totalBytes: 4194304, noticeLines: 10, noticeChars: 200 } as const;
/** A line that names the owner. It is the one part of a licence text that differs from file to file. */
export const COPYRIGHT_LINE_RE = /^\s*(?:copyright\s*(?:\(c\)|©|:|\d)|\(c\)|©)/i;
/**
 * An owner line: `Copyright (c) 2024 Example Person`. Only such a line is left out when a licence text is compared; any
 * other line that starts like one (a sentence, a restriction) stays in the text and so changes the result.
 */
export const OWNER_LINE_RE = /^\s*(?:copyright\s*(?:\(c\)|©)?|\(c\)|©)\s*(?:\d{4}(?:\s*[-–,]\s*\d{4})*\s*[,.]?\s*)?(\S[^\n]{0,59})$/i;
export const OWNER_MAX_WORDS = 7;
/** Words that make the rest of an owner line a sentence, not a name. */
export const OWNER_DENY_WORDS: readonly string[] = [
  "use", "used", "using", "is", "are", "be", "may", "must", "shall", "not", "only", "permitted", "permission", "allowed", "prohibited",
  "restricted", "purposes", "purpose", "commercial", "license", "licence", "terms", "conditions", "granted", "without", "notice",
  "software", "above", "holders", "claim", "copies", "this", "for", "any", "no",
];
/** The Apache-2.0 appendix line that is meant to be filled in. */
export const OWNER_PLACEHOLDER_RE = /^\s*copyright\s*\{yyyy\}\s*\{name of copyright owner\}\s*$/i;

/** Lower case, every run of non-alphanumerics is one space. */
export function normalizeLicenceText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const SOFTWARE_DISCLAIMER = `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const ISC_DISCLAIMER = `THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
const BSD_HEAD = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.`;
const BSD_NAME = `3. Neither the name of {name} nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.`;
const BSD_DISCLAIMER = `THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

export interface LicenceTemplate {
  id: string;
  /** The complete text. `{name}` stands for a name of up to 80 characters. Lines of owner and a title line may differ. */
  text: string;
  /** Normalised text that may follow the licence. */
  tail?: string;
}
/**
 * Short licences are recognised by their complete text, not by phrases: an added or removed sentence makes the file
 * "not identified" (and so ambiguous), never a different licence.
 */
export const LICENCE_TEMPLATES: readonly LicenceTemplate[] = [
  {
    id: "MIT",
    text: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

${SOFTWARE_DISCLAIMER}`,
  },
  {
    id: "ISC",
    text: `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

${ISC_DISCLAIMER}`,
  },
  {
    id: "0BSD",
    text: `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.

${ISC_DISCLAIMER}`,
  },
  { id: "BSD-2-Clause", text: `${BSD_HEAD}\n\n${BSD_DISCLAIMER}` },
  { id: "BSD-3-Clause", text: `${BSD_HEAD}\n\n${BSD_NAME}\n\n${BSD_DISCLAIMER}` },
  {
    id: "Unlicense",
    text: `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software, either in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this software dedicate any and all copyright interest in the software to the public domain. We make this dedication for the benefit of the public at large and to the detriment of our heirs and successors. We intend this dedication to be an overt act of relinquishment in perpetuity of all present and future rights to this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
    tail: "for more information please refer to https unlicense org",
  },
];
/** A title line a licence file may start with, in normalised form. */
export const LICENCE_TITLES: readonly string[] = ["mit license", "the mit license", "isc license", "bsd 2 clause license", "bsd 3 clause license", "the unlicense", "bsd zero clause license"];

export interface LicenceFingerprint {
  id: string;
  all: readonly string[];
  none?: readonly string[];
}
/**
 * A long licence is recognised by the sha256 of its normalised complete text, cut at `end of terms and conditions`: the
 * head must be one of `heads`, and what follows (owner lines left out) one of `tails` (the hash of the empty text is the
 * file that ends there). Any added or changed word gives no match. CC0-1.0 and CC-BY-4.0 have no entry: their complete
 * text is not part of this repository, so a file with either is "not recognised" and a skill under it is refused.
 */
export interface LicenceFullText {
  id: string;
  cut: RegExp;
  heads: readonly string[];
  tails: readonly string[];
}
export const LICENCE_FULL_TEXTS: readonly LicenceFullText[] = [
  {
    id: "Apache-2.0",
    cut: /end of terms and conditions/i,
    heads: ["f45538b138cf9aea39fa205de037a0bede8305e68281650e7ab809a8b3ebb2f0", "296a35b4f3b6a7e90a68c08362fc50009807cd0dfd4f78f36f4062bd4d202555"],
    tails: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "50bb8131750d8251aab3e2636df786bcfdcdb256ed4bd6e527fe167814988bed"],
  },
];
/** For licences without a template that policy refuses or sends to review. The phrases are in normalised form. */
export const LICENCE_FINGERPRINTS: readonly LicenceFingerprint[] = [
  { id: "MPL-2.0", all: ["mozilla public license version 2 0"] },
  { id: "EPL-2.0", all: ["eclipse public license"] },
  { id: "LGPL", all: ["gnu lesser general public license"] },
  { id: "AGPL", all: ["gnu affero general public license"] },
  { id: "GPL", all: ["gnu general public license"], none: ["lesser", "affero"] },
  { id: "CC-BY-SA-4.0", all: ["creative commons attribution sharealike 4 0"] },
  { id: "BUSL-1.1", all: ["business source license"] },
  { id: "SSPL-1.0", all: ["server side public license"] },
  { id: "Elastic-2.0", all: ["elastic license"] },
  { id: "PolyForm", all: ["polyform"] },
  { id: "CC-BY-NC", all: ["creative commons", "noncommercial"] },
  { id: "CC-BY-ND", all: ["creative commons", "noderivatives"], none: ["noncommercial"] },
];

/** Normalised. `license:` of SKILL.md may be `<prefix> <licence file name> <suffix>` and nothing else besides a known id. */
export const REFERENCE_PREFIXES: readonly string[] = ["", "see", "see the", "see file", "see the file", "the file", "in", "terms in", "complete terms in", "full terms in"];
export const REFERENCE_SUFFIXES: readonly string[] = ["", "file", "for details", "for complete terms", "for the complete terms", "for full terms"];

/** Normalised. Text with one of these is never accepted, whatever else it holds. */
export const REJECT_MARKERS: readonly string[] = [
  "commons clause", "noncommercial", "non commercial", "proprietary", "source available", "business source license",
  "server side public license", "elastic license", "polyform",
];
