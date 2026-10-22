import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicKeyLine, readSigningKey, signSsh, verifySshSignature } from "../src/delivery/sshsig.js";
import { rawPublicKey } from "../src/skills/release-signature.js";

const NS = "scf-delivery-contract";
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyOf = (n: number): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, n)]), format: "der", type: "pkcs8" });
const K1 = keyOf(1);
const K2 = keyOf(2);

const str = (b: Buffer | string): Buffer => {
  const buf = typeof b === "string" ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

interface Opts {
  cipher?: string;
  kdf?: string;
  kdfoptions?: Buffer;
  type?: string;
  comment?: string;
  outerKey?: KeyObject;
  innerPub?: Buffer;
  badPadding?: boolean;
  unaligned?: boolean;
  trailing?: boolean;
  check2?: number;
  wrongPrivHalf?: boolean;
}
/** Test-only writer of an `openssh-key-v1` file for an Ed25519 key. */
function opensshKeyText(key: KeyObject, o: Opts = {}): string {
  const pub = Buffer.from(rawPublicKey(key), "base64");
  const seed = (key.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const type = o.type ?? "ssh-ed25519";
  const outerPub = o.outerKey ? Buffer.from(rawPublicKey(o.outerKey), "base64") : pub;
  const priv64 = Buffer.concat([o.wrongPrivHalf ? Buffer.alloc(32, 9) : seed, pub]);
  let section = Buffer.concat([u32(7), u32(o.check2 ?? 7), str(type), str(o.innerPub ?? pub), str(priv64), str(o.comment ?? "test")]);
  let pad = 1;
  while (section.length % 8 !== 0) section = Buffer.concat([section, Buffer.from([o.badPadding ? 0 : pad++])]);
  if (o.unaligned) section = Buffer.concat([section, Buffer.from([1])]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    str(o.cipher ?? "none"),
    str(o.kdf ?? "none"),
    str(o.kdfoptions ?? Buffer.alloc(0)),
    u32(1),
    str(Buffer.concat([str(type), str(outerPub)])),
    str(section),
    o.trailing ? Buffer.from([0]) : Buffer.alloc(0),
  ]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

describe("SSH signature", () => {
  const sig = signSsh("hello", K1, NS);
  const line = publicKeyLine(K1);

  it("signs and verifies, and gives the same text every time", () => {
    expect(verifySshSignature("hello", sig, line, NS)).toEqual({ ok: true });
    expect(signSsh("hello", K1, NS)).toBe(sig);
  });

  it("round-trips a non-ASCII namespace", () => {
    const s = signSsh("hello", K1, "déploiement");
    expect(verifySshSignature("hello", s, line, "déploiement")).toEqual({ ok: true });
    expect(verifySshSignature("hello", s, line, "deploiement")).toEqual({ ok: false, fault: "namespace" });
  });

  it("is armoured the way OpenSSH writes it", () => {
    expect(sig.startsWith("-----BEGIN SSH SIGNATURE-----\n")).toBe(true);
    expect(sig.endsWith("\n-----END SSH SIGNATURE-----\n")).toBe(true);
    for (const l of sig.split("\n").slice(1, -2)) expect(l.length).toBeLessThanOrEqual(70);
  });

  it("writes the public key line", () => {
    expect(line).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/);
    expect(publicKeyLine(createPublicKey(K1))).toBe(line);
    expect(() => publicKeyLine(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey)).toThrow();
  });

  it("refuses a changed message, key, namespace or text", () => {
    expect(verifySshSignature("hellp", sig, line, NS)).toEqual({ ok: false, fault: "bad" });
    expect(verifySshSignature("hello", sig, publicKeyLine(K2), NS)).toEqual({ ok: false, fault: "wrong-key" });
    expect(verifySshSignature("hello", sig, line, "other")).toEqual({ ok: false, fault: "namespace" });
    expect(verifySshSignature("hello", sig, "garbage", NS)).toEqual({ ok: false, fault: "public-key" });
    expect(verifySshSignature("hello", sig.slice(0, 100), line, NS)).toEqual({ ok: false, fault: "malformed" });
    expect(verifySshSignature("hello", "", line, NS)).toEqual({ ok: false, fault: "malformed" });
    expect(verifySshSignature("hello", sig.replace(/\n/g, "\r\n"), line, NS)).toEqual({ ok: false, fault: "malformed" });
  });

  it("refuses every single changed character", () => {
    for (let i = 0; i < sig.length; i++) {
      const changed = sig.slice(0, i) + (sig[i] === "a" ? "b" : "a") + sig.slice(i + 1);
      expect(verifySshSignature("hello", changed, line, NS).ok, `char ${i}`).toBe(false);
    }
  });

  it("reports the first fault in the order of ssh-keygen", () => {
    const other = signSsh("other", K2, NS);
    expect(verifySshSignature("hello", other, line, NS)).toEqual({ ok: false, fault: "bad" });
    expect(verifySshSignature("changed", sig, "garbage", NS)).toEqual({ ok: false, fault: "bad" });
    expect(verifySshSignature("hello", sig.slice(0, 100), publicKeyLine(K2), NS)).toEqual({ ok: false, fault: "malformed" });
  });

  it("never throws", () => {
    for (const bad of [undefined, null, 5, {}, []]) {
      expect(verifySshSignature(bad as never, bad as never, bad as never, bad as never).ok).toBe(false);
    }
  });
});

describe("readSigningKey", () => {
  const ok = (text: string) => {
    const r = readSigningKey(text);
    expect(r.ok).toBe(true);
    return r.ok ? r.key : K1;
  };
  const reason = (text: string) => {
    const r = readSigningKey(text);
    return r.ok ? "ok" : r.reason;
  };

  it("reads PKCS#8 PEM", () => {
    const key = ok(K1.export({ type: "pkcs8", format: "pem" }) as string);
    expect(signSsh("m", key, NS)).toBe(signSsh("m", K1, NS));
  });

  it("reads the OpenSSH form", () => {
    expect(publicKeyLine(ok(opensshKeyText(K1)))).toBe(publicKeyLine(K1));
  });

  it("refuses encrypted keys", () => {
    expect(reason(K1.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "x" }) as string)).toBe("encrypted");
    expect(reason(opensshKeyText(K1, { cipher: "aes256-ctr", kdf: "bcrypt" }))).toBe("encrypted");
  });

  it("refuses keys of another type", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(reason(rsa.export({ type: "pkcs8", format: "pem" }) as string)).toBe("not-ed25519");
    expect(reason(rsa.export({ type: "pkcs1", format: "pem" }) as string)).toBe("not-ed25519");
    expect(reason(opensshKeyText(K1, { type: "ssh-rsa" }))).toBe("not-ed25519");
  });

  it("refuses files that are not well formed", () => {
    const pubPem = createPublicKey(K1).export({ type: "spki", format: "pem" }) as string;
    const good = opensshKeyText(K1);
    const cases: Record<string, string> = {
      "a public key": pubPem,
      empty: "",
      "two keys": good + good,
      "changed check2": opensshKeyText(K1, { check2: 8 }),
      "private half": opensshKeyText(K1, { wrongPrivHalf: true }),
      "outer key": opensshKeyText(K1, { outerKey: K2 }),
      "inner key": opensshKeyText(K1, { innerPub: Buffer.alloc(32, 5) }),
      kdfoptions: opensshKeyText(K1, { kdfoptions: Buffer.from([1]) }),
      padding: opensshKeyText(K1, { badPadding: true }),
      unaligned: opensshKeyText(K1, { unaligned: true }),
      trailing: opensshKeyText(K1, { trailing: true }),
      long: opensshKeyText(K1, { comment: "x".repeat(17000) }),
    };
    for (const [name, text] of Object.entries(cases)) expect(reason(text), name).toBe("unreadable");
  });
});

describe.skipIf(!existsSync("/usr/bin/ssh-keygen"))("real ssh-keygen", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "scf-sshsig-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (args: string[], input?: string) => execFileSync("/usr/bin/ssh-keygen", args, { input, stdio: ["pipe", "pipe", "pipe"] });

  it("accepts our signature", () => {
    const d = tmp();
    writeFileSync(join(d, "allowed"), `scf ${publicKeyLine(K1)}\n`);
    writeFileSync(join(d, "sig"), signSsh("the message", K1, NS));
    const args = ["-Y", "verify", "-f", join(d, "allowed"), "-I", "scf", "-n", NS, "-s", join(d, "sig")];
    run(args, "the message");
    expect(() => run(args, "the messagf")).toThrow();
  });

  it("reads its key and accepts its signature", () => {
    const d = tmp();
    run(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", join(d, "key")]);
    const r = readSigningKey(readFileSync(join(d, "key"), "utf8"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(publicKeyLine(r.key)).toBe(readFileSync(join(d, "key.pub"), "utf8").split(" ").slice(0, 2).join(" "));
    writeFileSync(join(d, "msg"), "payload");
    run(["-Y", "sign", "-f", join(d, "key"), "-n", NS, join(d, "msg")]);
    expect(verifySshSignature("payload", readFileSync(join(d, "msg.sig"), "utf8"), publicKeyLine(r.key), NS)).toEqual({ ok: true });
  });

  it("refuses its encrypted key", () => {
    const d = tmp();
    run(["-q", "-t", "ed25519", "-N", "pass", "-a", "1", "-f", join(d, "enc")]);
    const r = readSigningKey(readFileSync(join(d, "enc"), "utf8"));
    expect(r.ok ? "ok" : r.reason).toBe("encrypted");
  });
});
