// Credential and endpoint scan for skill packages. The rules below are copied verbatim from `tools/secret-scan`
// (a script, so it cannot be imported; tests/skill-credential-scan.test.ts keeps the two in step).
// The result is only ever a rule name: no part of the scanned text is returned.

export const CREDENTIAL_RULES: readonly (readonly [string, RegExp])[] = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["AWS secret key", /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Slack webhook", /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["Linear key", /\blin_api_[A-Za-z0-9]{40}\b/],
  ["connection string with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]{6,}@/],
  ["hard-coded secret", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i],
];
export const KEY_DATA = /[A-Za-z0-9+/]{40,}={0,2}/;
export const PLACEHOLDER = /^(?:x+|\*+|changeme|example|placeholder|your[_-]|<|\$\{|\{\{|process\.env|os\.environ|test|dummy|fake|redacted)/i;
export const RISKY_FILE = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key|keystore|jks))$/;
export const SAFE_FILE = /\.(?:example|sample|template|dist)$|\.env\.(?:example|sample|template)$|\.pub$/;

export const ENDPOINT_RULE = "connection endpoint";
export const ENDPOINT_SCHEMES: ReadonlySet<string> = new Set([
  "postgres", "postgresql", "mysql", "mariadb", "mongodb", "mongodb+srv", "redis", "rediss", "amqp", "amqps", "kafka",
  "nats", "mqtt", "mqtts", "ldap", "ldaps", "sqlserver", "db2", "cassandra", "clickhouse", "tcp", "tcps",
]);
const PASSWORD_RULE = "connection string with password";
export const CREDENTIAL_RULE_NAMES: readonly string[] = [...CREDENTIAL_RULES.map((r) => r[0]), ENDPOINT_RULE];

const TEMPLATE = /<[^>]*>|\$\{|\{\{|%[A-Za-z_]\w*%|\$[A-Z][A-Z0-9_]+/;
const placeholder = (v: string) => PLACEHOLDER.test(v) || TEMPLATE.test(v);
const ADDRESS = /\b([a-z][a-z0-9+.-]{1,30}):\/\/([^\s"'`]{1,300})/gi;
const ORACLE = /\bjdbc:oracle:[a-z0-9]{1,10}:([^\s"'`@]{0,200})@(?:tcps?:\/\/|\/\/)?([^\s"'`]{1,300})/gi;
const EXAMPLE_HOSTS = new Set(["localhost", "host", "hostname", "server", "broker", "db"]);
const EXAMPLE_NAME = /(?:^|\.)(?:localhost|example|test|invalid|example\.(?:com|org|net))$/;
const DOC_IPV4 = /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;

const GLOBAL_RULES = CREDENTIAL_RULES.map(([name, re]) => [name, new RegExp(re.source, re.flags + "g")] as const);

function hostOf(s: string): string {
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end < 0 ? s : s.slice(0, end + 1);
  }
  return /^[^\s/?#;,:)\\|]*/.exec(s)![0];
}

/** True when the host names a real machine: not empty, a placeholder, a documentation address or an example name. */
function realHost(raw: string): boolean {
  if (raw.startsWith("[")) {
    const h = raw.replace(/^\[|\]$/g, "").toLowerCase();
    return /^[0-9a-f:.]+$/.test(h) && h.includes(":") && h !== "::1" && h !== "::";
  }
  const h = raw.toLowerCase().replace(/\.+$/, "");
  if (!h || !/^[a-z0-9.-]+$/.test(h)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return !DOC_IPV4.test(h);
  return !EXAMPLE_HOSTS.has(h) && !EXAMPLE_NAME.test(h);
}

/** A password part of 6 or more characters that is not a placeholder. */
const realPassword = (v: string) => v.length >= 6 && !placeholder(v);

/** The name of the first rule the text trips, or undefined. Never returns any part of the text. */
export function credentialProblem(text: string): string | undefined {
  for (const [name, re] of GLOBAL_RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const value = m[1] ?? m[0];
      if (name === "private key") {
        const end = m.index + m[0].length;
        if (!KEY_DATA.test(text.slice(end, end + 300))) continue;
      } else if (name === PASSWORD_RULE) {
        const creds = m[0].slice(m[0].indexOf("://") + 3, -1);
        if (placeholder(creds.slice(creds.indexOf(":") + 1))) continue;
      } else if (name === "hard-coded secret") {
        if (placeholder(value) || !/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue;
      }
      return name;
    }
  }

  ADDRESS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ADDRESS.exec(text))) {
    ADDRESS.lastIndex = m.index + m[1]!.length + 3; // a URL inside another one is still seen
    const auth = /^[^/?#]*/.exec(m[2]!)![0];
    const at = auth.lastIndexOf("@");
    if (at >= 0) {
      const user = auth.slice(0, at);
      const colon = user.indexOf(":");
      if (colon >= 0 && realPassword(user.slice(colon + 1))) return PASSWORD_RULE;
    }
    if (ENDPOINT_SCHEMES.has(m[1]!.toLowerCase()) && realHost(hostOf(auth.slice(at + 1)))) return ENDPOINT_RULE;
  }

  ORACLE.lastIndex = 0;
  while ((m = ORACLE.exec(text))) {
    const slash = m[1]!.indexOf("/");
    if (slash >= 0 && realPassword(m[1]!.slice(slash + 1))) return PASSWORD_RULE;
    if (realHost(hostOf(m[2]!))) return ENDPOINT_RULE;
  }
  return undefined;
}

/** True when the path is a credential file by its name (.env, *.pem, id_rsa, …). */
export function riskyFileName(path: string): boolean {
  const p = path.toLowerCase();
  return RISKY_FILE.test(p) && !SAFE_FILE.test(p);
}
