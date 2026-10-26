import { firstLine, reportFirst } from "../next-step.js";
// help/guard.js and help/store.js import each other (through the credential store); the store has to load first.
import "../help/store.js";
import { scrub } from "../help/guard.js";
import { contractDigest, deliveryContractText } from "./contract.js";
import { DeliveryContractSchema, STOP_CONDITIONS, type DeliveryContract, type StopCondition } from "./schema.js";
import { parseSshSignature } from "./sshsig.js";
import { DELIVERY_DIR } from "./write.js";

/** The delivery-contract pull request comment: written by the Foundry, read by tools/delivery-validate. */
export const MAX_COMMENT_CHARS = 60_000;
export const MAX_CHECK_LINES = 50;
export const MAX_SAFE_CHARS = 300;
export const DELIVERY_MARKER_RE = /^<!-- (claude-factory|spaghetti-code-foundry) delivery-contract run=[\w-]+ -->$/;
/** Same as MARKER in tools/delivery-validate/validate.mjs. */
export const VALIDATOR_MARKER_RE = /^<!-- claude-factory delivery-contract digest=([0-9a-f]{64}) evidence=([0-9a-f]{64}) -->$/;
export const CONTRACT_INFO = "json scf-delivery-contract";
export const SIGNATURE_INFO = "text scf-delivery-signature";

const RUN_ID_RE = /^[\w-]{1,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** An input does not fit the comment. The message names the input, never its value. */
export class DeliveryCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryCommentError";
  }
}

export interface DeliveryCommentInput {
  status: { kind: "ok" | "stop" | "unsigned"; condition?: StopCondition; reason?: string };
  /** One line per check; each goes through safeLine. */
  lines: string[];
  contract?: DeliveryContract;
  /** Must be deliveryContractText(contract) when given. */
  text?: string;
  /** SSHSIG armour of the signature over `text`. */
  signature?: string;
  /** Must be contractDigest(text) when given. */
  digest?: string;
  fingerprint?: string;
}
export interface DeliveryCommentRead { contract?: string; signature?: string; digest?: string; evidence?: string }

export function deliveryMarker(runId: string): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new DeliveryCommentError("the run id is not usable in a marker");
  return `<!-- spaghetti-code-foundry delivery-contract run=${runId} -->`;
}

export function validatorMarker(digest: string, evidence: string): string {
  if (typeof digest !== "string" || !HEX64_RE.test(digest)) throw new DeliveryCommentError("the digest is not 64 lower-case hex characters");
  if (typeof evidence !== "string" || !HEX64_RE.test(evidence)) throw new DeliveryCommentError("the evidence hash is not 64 lower-case hex characters");
  return `<!-- claude-factory delivery-contract digest=${digest} evidence=${evidence} -->`;
}

const splitLines = (body: string): string[] => body.replace(/\r\n/g, "\n").split("\n");

/** Is the last non-empty line the delivery marker of any run? Quoting it elsewhere does not count. */
export function isDeliveryComment(c: { body: string }): boolean {
  if (typeof c?.body !== "string") return false;
  const last = splitLines(c.body).map((l) => l.trim()).filter(Boolean).at(-1);
  return last !== undefined && DELIVERY_MARKER_RE.test(last);
}

/**
 * Text from a caller as one safe line: secrets taken out (scrub, which throws GuardError when it cannot be sure),
 * white space folded, angle brackets and backticks replaced (nothing is deleted, so no delimiter or token can be
 * rebuilt), mentions neutralised, at most MAX_SAFE_CHARS characters counting the ellipsis.
 */
export function safeLine(t: string): string {
  const s = scrub(String(t)).text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/`/g, "'")
    .replace(/@(?=\w)/g, "@​");
  const chars = [...s];
  return chars.length > MAX_SAFE_CHARS ? `${chars.slice(0, MAX_SAFE_CHARS - 1).join("")}…` : s;
}

function fence(content: string): string {
  // A loop, not Math.max(...matches): a large contract has more runs than a call can take as arguments.
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

const block = (info: string, content: string): string[] => {
  const f = fence(content);
  return [`${f}${info}`, content, f];
};

function readBlock(lines: string[], info: string): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})(.*)$/.exec(lines[i]!);
    if (!open || open[2] !== info) continue;
    for (let j = i + 1; j < lines.length; j++) if (lines[j] === open[1]) return lines.slice(i + 1, j).join("\n");
    return undefined;
  }
  return undefined;
}

/** The contract must fit its schema and hold no secret in any string; it is refused, not redacted, so the signed bytes stay exact. */
function checkContract(contract: DeliveryContract): void {
  if (!DeliveryContractSchema.safeParse(contract).success) throw new DeliveryCommentError("the contract does not fit the contract schema");
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (scrub(v).removed.length) throw new DeliveryCommentError(`the contract holds a secret at ${path}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(contract, "");
}

export function deliveryCommentBody(input: DeliveryCommentInput, runId: string): string {
  const marker = deliveryMarker(runId);
  const { status, contract } = input;
  if (!["ok", "stop", "unsigned"].includes(status?.kind)) throw new DeliveryCommentError("the status is not known");
  let text: string | undefined;
  let digest: string | undefined;
  if (contract) {
    checkContract(contract);
    text = deliveryContractText(contract);
    if (input.text !== undefined && input.text !== text) throw new DeliveryCommentError("the text is not the canonical text of the contract");
    digest = contractDigest(text);
    if (input.digest !== undefined && (!HEX64_RE.test(input.digest) || input.digest !== digest)) throw new DeliveryCommentError("the digest is not the digest of the contract");
  } else if (input.text !== undefined || input.signature !== undefined || input.digest !== undefined) {
    throw new DeliveryCommentError("a text, signature or digest needs a contract");
  }
  const sig = input.signature;
  if (sig !== undefined && parseSshSignature(sig) === undefined) throw new DeliveryCommentError("the signature is not an SSH signature");
  if (status.kind === "ok" && (!contract || sig === undefined)) throw new DeliveryCommentError("a verified comment needs a contract and a signature");
  if (status.kind === "unsigned" && sig !== undefined) throw new DeliveryCommentError("an unsigned comment cannot have a signature");

  const first = status.kind === "stop"
    ? firstLine({ who: "You", action: "Look at why the delivery stopped, fix it, and run again", why: "" })
    : reportFirst("info");
  let statusLine: string;
  if (status.kind === "ok") statusLine = "**Verified.**";
  else if (status.kind === "unsigned") statusLine = "**Not verified.** No signing key is set, so the contract is unsigned.";
  else {
    const reason = status.reason ? safeLine(status.reason) : "";
    const known = status.condition !== undefined && (STOP_CONDITIONS as readonly string[]).includes(status.condition);
    statusLine = known ? `**Stopped:** \`${status.condition}\`${reason ? ` — ${reason}` : ""}` : `**Stopped.**${reason ? ` ${reason}` : ""}`;
  }

  const bullets: string[] = [];
  if (contract) {
    const key = sig !== undefined && input.fingerprint !== undefined && FINGERPRINT_RE.test(input.fingerprint) ? `\`${input.fingerprint}\`` : "unsigned";
    bullets.push(
      `- **Contract:** run \`${contract.runId}\`, sequence ${contract.sequence}, digest \`${digest}\``,
      `- **Commit:** \`${contract.commit.sha}\` on branch \`${safeLine(contract.commit.branch)}\``,
      `- **Evidence:** ${contract.evidence.count} events, terminal hash \`${contract.evidence.terminalHash}\``,
      `- **Key:** ${key}`,
    );
  } else {
    bullets.push("- **Contract:** none was written");
  }

  const checks = input.lines.map(safeLine).filter(Boolean);
  const checkLines = checks.slice(0, MAX_CHECK_LINES).map((l) => `- ${l}`);
  if (checks.length > MAX_CHECK_LINES) checkLines.push(`- … and ${checks.length - MAX_CHECK_LINES} more checks`);

  const assemble = (details: string[]): string => {
    const out = [first, "", "### Delivery contract", "", statusLine, "", ...bullets, ""];
    if (checkLines.length) out.push(...checkLines, "");
    if (details.length) out.push(...details, "");
    if (contract && digest) out.push(validatorMarker(digest, contract.evidence.terminalHash));
    out.push(marker);
    return out.join("\n");
  };

  if (!contract || text === undefined) return assemble([]);
  const details = [
    "<details><summary>Contract and signature</summary>", "",
    ...block(CONTRACT_INFO, text),
    ...(sig !== undefined ? ["", ...block(SIGNATURE_INFO, sig.slice(0, -1))] : []),
    "", "</details>",
  ];
  const full = assemble(details);
  if (full.length <= MAX_COMMENT_CHARS) return full;
  return assemble([`The contract is too long for a comment. It is in \`${DELIVERY_DIR}/contract-${contract.sequence}.json\` in the run folder.`]);
}

/** What the comment holds: the contract text, the signature (with its closing line end), the digest and the evidence hash. Never throws. */
export function readDeliveryComment(body: string): DeliveryCommentRead {
  const read: DeliveryCommentRead = {};
  try {
    if (typeof body !== "string") return read;
    const lines = splitLines(body);
    const contract = readBlock(lines, CONTRACT_INFO);
    if (contract !== undefined) read.contract = contract;
    const sig = readBlock(lines, SIGNATURE_INFO);
    if (sig !== undefined) read.signature = `${sig}\n`;
    const found = lines.map((l) => VALIDATOR_MARKER_RE.exec(l)).filter((m) => m !== null);
    if (found.length === 1) {
      read.digest = found[0]![1];
      read.evidence = found[0]![2];
    }
  } catch {
    // Nothing more can be read.
  }
  return read;
}
