import { createHash, createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { decodeBase64Exact, ed25519PublicKey, rawPublicKey } from "../skills/release-signature.js";

/**
 * An SSH signature in the OpenSSH `SSHSIG` format (PROTOCOL.sshsig), in plain Node: Ed25519, SHA-512, armoured.
 * `ssh-keygen -Y verify` accepts what `signSsh` writes, and `verifySshSignature` accepts what `ssh-keygen -Y sign`
 * writes. The verifier only accepts the exact armour OpenSSH writes, so any changed byte of the text fails.
 */

const MAGIC = Buffer.from("SSHSIG", "latin1");
const KEY_TYPE = "ssh-ed25519";
const HASH_ALGORITHM = "sha512";
const BEGIN = "-----BEGIN SSH SIGNATURE-----\n";
const END = "-----END SSH SIGNATURE-----\n";
const KEY_TEXT_MAX = 16 * 1024;
/** DER prefix of an Ed25519 PKCS#8 private key; the 32 seed bytes follow. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const sshString = (data: Uint8Array | string): Buffer => {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error("short");
    const n = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return n;
  }
  bytes(): Buffer {
    const n = this.u32();
    if (this.pos + n > this.buf.length) throw new Error("short");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  raw(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error("short");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  text(): string {
    return this.bytes().toString("latin1");
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
  done(): boolean {
    return this.pos === this.buf.length;
  }
}

const ed25519Blob = (raw: Uint8Array): Buffer => Buffer.concat([sshString(KEY_TYPE), sshString(raw)]);

function armour(blob: Buffer): string {
  const b64 = blob.toString("base64");
  let out = BEGIN;
  for (let i = 0; i < b64.length; i += 70) out += `${b64.slice(i, i + 70)}\n`;
  return out + END;
}

function signedData(message: string | Uint8Array, namespace: string): Buffer {
  const digest = createHash(HASH_ALGORITHM).update(message).digest();
  return Buffer.concat([MAGIC, sshString(namespace), sshString(""), sshString(HASH_ALGORITHM), sshString(digest)]);
}

function requireEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the key is not an Ed25519 key");
}

/** `ssh-ed25519 AAAA…` (no comment). Takes a private or a public Ed25519 key; throws for any other key. */
export function publicKeyLine(key: KeyObject): string {
  requireEd25519(key);
  return `${KEY_TYPE} ${ed25519Blob(Buffer.from(rawPublicKey(key), "base64")).toString("base64")}`;
}

/** The armoured SSHSIG signature of `message`. Ed25519 is deterministic: the same input gives the same text. */
export function signSsh(message: string | Uint8Array, key: KeyObject, namespace: string): string {
  requireEd25519(key);
  if (typeof namespace !== "string" || namespace === "") throw new Error("the namespace must not be empty");
  const sig = sign(null, signedData(message, namespace), key);
  const pub = Buffer.from(rawPublicKey(key), "base64");
  const blob = Buffer.concat([
    MAGIC,
    Buffer.from([0, 0, 0, 1]),
    sshString(ed25519Blob(pub)),
    sshString(namespace),
    sshString(""),
    sshString(HASH_ALGORITHM),
    sshString(Buffer.concat([sshString(KEY_TYPE), sshString(sig)])),
  ]);
  return armour(blob);
}

export type SshSignatureFault = "malformed" | "namespace" | "bad" | "public-key" | "wrong-key";
export type SshSignatureCheck = { ok: true } | { ok: false; fault: SshSignatureFault };

/**
 * Checks, in the order of `ssh-keygen -Y verify`: the form, the namespace, the signature against the key inside it,
 * and only then that this key is the trusted one. Never throws.
 */
export function verifySshSignature(message: string | Uint8Array, armoured: string, trustedKeyLine: string, namespace: string): SshSignatureCheck {
  const fail = (fault: SshSignatureFault): SshSignatureCheck => ({ ok: false, fault });
  try {
    if (typeof armoured !== "string" || !armoured.startsWith(BEGIN) || !armoured.endsWith(END)) return fail("malformed");
    const b64 = armoured.slice(BEGIN.length, armoured.length - END.length).replace(/\n/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail("malformed");
    const blob = Buffer.from(b64, "base64");
    if (blob.toString("base64") !== b64 || armour(blob) !== armoured) return fail("malformed");

    const r = new Reader(blob);
    if (!r.raw(MAGIC.length).equals(MAGIC) || r.u32() !== 1) return fail("malformed");
    const pubBlob = new Reader(r.bytes());
    if (pubBlob.text() !== KEY_TYPE) return fail("malformed");
    const embedded = pubBlob.bytes();
    if (embedded.length !== 32 || !pubBlob.done()) return fail("malformed");
    const ns = r.bytes();
    if (r.bytes().length !== 0 || r.text() !== HASH_ALGORITHM) return fail("malformed");
    const sigBlob = new Reader(r.bytes());
    if (sigBlob.text() !== KEY_TYPE) return fail("malformed");
    const sig = sigBlob.bytes();
    if (sig.length !== 64 || !sigBlob.done() || !r.done()) return fail("malformed");

    if (typeof namespace !== "string" || !ns.equals(Buffer.from(namespace, "utf8"))) return fail("namespace");
    if (!verify(null, signedData(message, namespace), ed25519PublicKey(embedded), sig)) return fail("bad");

    const trusted = parseKeyLine(trustedKeyLine);
    if (!trusted) return fail("public-key");
    if (!trusted.equals(embedded)) return fail("wrong-key");
    return { ok: true };
  } catch {
    return fail("malformed");
  }
}

/** The 32 raw bytes of an `ssh-ed25519 AAAA…` line, or undefined. */
export function parseKeyLine(line: string): Buffer | undefined {
  try {
    if (typeof line !== "string") return undefined;
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== KEY_TYPE || parts[1] === undefined) return undefined;
    const blob = decodeBase64Exact(parts[1], 4 + KEY_TYPE.length + 4 + 32);
    if (!blob) return undefined;
    const r = new Reader(blob);
    if (r.text() !== KEY_TYPE) return undefined;
    const raw = r.bytes();
    return raw.length === 32 && r.done() ? Buffer.from(raw) : undefined;
  } catch {
    return undefined;
  }
}

export type SigningKeyFault = "unreadable" | "encrypted" | "not-ed25519";
export type SigningKeyRead = { ok: true; key: KeyObject } | { ok: false; reason: SigningKeyFault; message: string };

const refuse = (reason: SigningKeyFault, message: string): SigningKeyRead => ({ ok: false, reason, message });

/** Reads an unencrypted Ed25519 private key in OpenSSH form or PKCS#8 PEM. Refuses anything else. Never throws. */
export function readSigningKey(text: string): SigningKeyRead {
  try {
    if (typeof text !== "string" || text.length > KEY_TEXT_MAX) return refuse("unreadable", "the key file is missing or too long");
    if ((text.match(/-----BEGIN/g) ?? []).length !== 1) return refuse("unreadable", "the file must hold exactly one key");
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /Proc-Type:\s*4,ENCRYPTED/.test(text)) return refuse("encrypted", "the key is encrypted");
    if (/-----BEGIN (?:RSA|EC|DSA) PRIVATE KEY-----/.test(text)) return refuse("not-ed25519", "the key is not an Ed25519 key");
    if (text.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) return readOpenSshKey(text);
    if (text.includes("-----BEGIN PRIVATE KEY-----")) {
      const key = createPrivateKey({ key: text, format: "pem" });
      return key.asymmetricKeyType === "ed25519" ? { ok: true, key } : refuse("not-ed25519", "the key is not an Ed25519 key");
    }
    return refuse("unreadable", "the file is not a private key");
  } catch {
    return refuse("unreadable", "the key could not be read");
  }
}

function readOpenSshKey(text: string): SigningKeyRead {
  const bad = (m = "the OpenSSH key file is not well formed") => refuse("unreadable", m);
  const m = /^-----BEGIN OPENSSH PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END OPENSSH PRIVATE KEY-----\s*$/.exec(text.trim());
  if (!m) return bad();
  const body = (m[1] ?? "").replace(/\s+/g, "");
  const data = Buffer.from(body, "base64");
  if (data.toString("base64") !== body) return bad();
  const magic = Buffer.from("openssh-key-v1\0", "latin1");
  if (data.length < magic.length || !data.subarray(0, magic.length).equals(magic)) return bad();
  const r = new Reader(data.subarray(magic.length));
  const cipher = r.text();
  const kdf = r.text();
  const kdfOptions = r.bytes();
  if (cipher !== "none" || kdf !== "none") return refuse("encrypted", "the key is encrypted");
  if (kdfOptions.length !== 0) return bad();
  if (r.u32() !== 1) return bad();
  const outer = new Reader(r.bytes());
  const outerType = outer.text();
  if (outerType !== KEY_TYPE) return refuse("not-ed25519", "the key is not an Ed25519 key");
  const outerPub = outer.bytes();
  if (outerPub.length !== 32 || !outer.done()) return bad();
  const priv = r.bytes();
  if (!r.done() || priv.length % 8 !== 0) return bad();
  return finishOpenSsh(priv, outerPub, bad);
}

function finishOpenSsh(priv: Buffer, outerPub: Buffer, bad: () => SigningKeyRead): SigningKeyRead {
  const p = new Reader(priv);
  const check1 = p.u32();
  const check2 = p.u32();
  if (check1 !== check2) return bad();
  if (p.text() !== KEY_TYPE) return bad();
  const innerPub = p.bytes();
  const innerPriv = p.bytes();
  if (innerPub.length !== 32 || !innerPub.equals(outerPub) || innerPriv.length !== 64 || !innerPriv.subarray(32).equals(innerPub)) return bad();
  p.bytes(); // the comment
  const pad = p.remaining();
  const padding = p.raw(pad);
  for (let i = 0; i < pad; i++) if (padding[i] !== i + 1) return bad();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, innerPriv.subarray(0, 32)]), format: "der", type: "pkcs8" });
  if (Buffer.from(rawPublicKey(key), "base64").compare(innerPub) !== 0) return bad();
  return { ok: true, key };
}
