// The rules of the static skill scanner (src/skills/scan.ts). Data only: no imports, nothing is run here.
//
// Contract: rule ids and SCAN_ID_HEADER are used by #473. A finding id is a hash of both, so renaming a rule or
// changing the header invalidates stored exceptions.
//
// Pattern constraints (they bound the cost of a scan; tests/skill-scan.test.ts times crafted inputs):
// - every pattern starts with a literal or `\b` plus literals;
// - every gap is bounded (`[^\n]{0,N}`, N <= 200), with at most one long gap per alternative;
// - no nested quantifiers.
// Other constraints: tests/skill-no-network.test.ts rejects some words in every src/skills/*.ts, so call patterns
// put `\s*` between the name and an escaped parenthesis. No `says` sentence quotes a pattern, and no line may
// trip CREDENTIAL_RULES.

export const SCAN_ID_HEADER = "scf-skill-scan-v1\n";
export const SCAN_CATEGORIES = [
  "credential-request", "prompt-injection", "policy-override", "unsafe-network", "destructive-action",
  "hidden-dependency", "secret", "executable-payload", "unsupported-binary", "path-escape", "obfuscation",
] as const;
export const SCAN_SEVERITIES = ["low", "medium", "high"] as const;
export type ScanCategory = (typeof SCAN_CATEGORIES)[number];
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];
export type ScanScope = "any" | "script";

export interface TextRule {
  id: string;
  severity: ScanSeverity;
  scope: ScanScope;
  says: string;
  re: RegExp;
  /** False: the matched text is never shown, only its length. */
  excerpt?: false;
}
export interface MagicRule {
  id: string;
  severity: ScanSeverity;
  says: string;
  offset: number;
  bytes: readonly number[];
}
export interface AllowedBinary {
  extensions: readonly string[];
  parts: readonly { offset: number; bytes: readonly number[] }[];
}
export interface FixedRule {
  id: string;
  severity: ScanSeverity;
  says: string;
}

/** The category of a rule id: the part before the first dot. */
export const categoryOf = (ruleId: string): ScanCategory => {
  const head = ruleId.slice(0, ruleId.indexOf("."));
  const found = SCAN_CATEGORIES.find((c) => c === head);
  if (!found) throw new Error(`unknown scan category in rule id: ${ruleId}`);
  return found;
};

export const FIXED_RULES = {
  secretContent: { id: "secret.content", severity: "high", says: "Holds what looks like a credential" },
  secretFileName: { id: "secret.file-name", severity: "high", says: "The file name holds what looks like a credential" },
  credentialFile: { id: "secret.credential-file", severity: "high", says: "The file is named like a credential file" },
  filePath: { id: "path-escape.file-path", severity: "high", says: "The file path leaves the package or is not a plain relative path" },
  unknownBinary: { id: "unsupported-binary.unknown", severity: "high", says: "Binary content that is not a known safe format" },
  bidiChars: { id: "obfuscation.bidi-chars", severity: "high", says: "Text direction control character" },
  invisibleChars: { id: "obfuscation.invisible-chars", severity: "high", says: "Invisible formatting character" },
  controlChars: { id: "obfuscation.control-chars", severity: "medium", says: "Control character" },
} as const satisfies Record<string, FixedRule>;

export const DOC_EXTENSIONS: readonly string[] = [".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc"];
export const DOC_NAMES: readonly string[] = ["LICENSE", "LICENCE", "COPYING", "NOTICE", "README", "CHANGELOG", "AUTHORS", "CONTRIBUTING"];

const exe = (id: string, says: string, bytes: number[], offset = 0): MagicRule => ({ id, severity: "high", says, offset, bytes });
const arch = (says: string, bytes: number[], offset = 0): MagicRule => exe("unsupported-binary.archive", says, bytes, offset);
const data = (says: string, bytes: number[]): MagicRule => ({ id: "unsupported-binary.data-file", severity: "low", says, offset: 0, bytes });

export const MAGIC_RULES: readonly MagicRule[] = [
  exe("executable-payload.elf", "ELF executable", [0x7f, 0x45, 0x4c, 0x46]),
  exe("executable-payload.macho", "Mach-O executable", [0xfe, 0xed, 0xfa, 0xce]),
  exe("executable-payload.macho", "Mach-O executable", [0xfe, 0xed, 0xfa, 0xcf]),
  exe("executable-payload.macho", "Mach-O executable", [0xce, 0xfa, 0xed, 0xfe]),
  exe("executable-payload.macho", "Mach-O executable", [0xcf, 0xfa, 0xed, 0xfe]),
  exe("executable-payload.fat-or-class", "Universal binary or Java class file", [0xca, 0xfe, 0xba, 0xbe]),
  exe("executable-payload.pe", "Windows executable", [0x4d, 0x5a]),
  exe("executable-payload.wasm", "WebAssembly module", [0x00, 0x61, 0x73, 0x6d]),
  arch("Zip archive", [0x50, 0x4b, 0x03, 0x04]),
  arch("Zip archive", [0x50, 0x4b, 0x05, 0x06]),
  arch("Gzip archive", [0x1f, 0x8b]),
  arch("Bzip2 archive", [0x42, 0x5a, 0x68]),
  arch("Xz archive", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
  arch("7z archive", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  arch("Rar archive", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
  arch("Zstandard archive", [0x28, 0xb5, 0x2f, 0xfd]),
  arch("Ar or deb archive", [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]),
  arch("Cab archive", [0x4d, 0x53, 0x43, 0x46]),
  arch("Tar archive", [0x75, 0x73, 0x74, 0x61, 0x72], 257),
  data("PDF document", [0x25, 0x50, 0x44, 0x46]),
  data("TrueType font", [0x00, 0x01, 0x00, 0x00]),
  data("OpenType font", [0x4f, 0x54, 0x54, 0x4f]),
  data("WOFF font", [0x77, 0x4f, 0x46, 0x46]),
  data("WOFF2 font", [0x77, 0x4f, 0x46, 0x32]),
];

export const ALLOWED_BINARY: readonly AllowedBinary[] = [
  { extensions: [".png"], parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  { extensions: [".jpg", ".jpeg"], parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { extensions: [".gif"], parts: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }] },
  { extensions: [".webp"], parts: [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }] },
];

const rule = (id: string, severity: ScanSeverity, says: string, re: RegExp, scope: ScanScope = "any", excerpt?: false): TextRule =>
  excerpt === false ? { id, severity, scope, says, re, excerpt } : { id, severity, scope, says, re };

export const TEXT_RULES: readonly TextRule[] = [
  // credential-request
  rule("credential-request.ask-secret", "high", "Asks the user for a secret",
    /\b(?:ask|prompt|tell|request|instruct)\s+(?:the\s+)?(?:user|developer|human|operator)\s+(?:to\s+)?(?:for|paste|enter|share|send|provide|type|give)\b[^\n]{0,60}\b(?:password|passphrase|api[ _-]?key|secret|token|credentials?|private key|seed phrase)\b/i),
  rule("credential-request.read-secret-file", "high", "Reads a file that holds credentials",
    /(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[\w.-]{1,40})\/\.(?:ssh\/id_|aws\/credentials|netrc|npmrc|docker\/config\.json|gnupg\/|kube\/config|config\/gh\/hosts\.yml)|\/etc\/shadow\b/i),
  rule("credential-request.env-dump", "medium", "Sends the environment to another program",
    /\b(?:printenv|env)\s{0,4}\|\s{0,4}(?:curl|wget|nc|base64)\b/i),
  rule("credential-request.env-secret", "low", "Sets an environment variable that holds a secret",
    /\b(?:export|setx?)\s+[A-Za-z0-9_]{0,40}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]{0,40}\s{0,4}=/i),

  // prompt-injection
  rule("prompt-injection.ignore-instructions", "high", "Tells the agent to ignore its earlier instructions",
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|messages|directions)\b/i),
  rule("prompt-injection.hide-from-user", "high", "Tells the agent to hide something from the user",
    /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|show\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|human|developer|operator)\b/i),
  rule("prompt-injection.reveal-system-prompt", "medium", "Asks the agent to reveal its system prompt",
    /\b(?:reveal|print|output|repeat|show|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system|hidden|initial)\s+(?:prompt|instructions)\b/i),
  rule("prompt-injection.role-override", "medium", "Tries to change the role of the agent",
    /\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|jailbroken|unrestricted|an?\s+unrestricted)\b|\bnew\s+system\s+prompt\s{0,4}:/i),
  rule("prompt-injection.fake-turn", "medium", "Looks like a message from the system or the assistant",
    /<\/?(?:system|system-reminder|assistant)>|\[\/?INST\]|<\|im_start\|>/i),

  // policy-override
  rule("policy-override.skip-flag", "high", "Uses a flag that skips permission checks",
    /--dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|\bbypassPermissions\b/i),
  rule("policy-override.disable-safety", "medium", "Tells the agent to turn off a safety check",
    /\b(?:disable|bypass|turn\s+off|circumvent|skip)\s+(?:the\s+|all\s+|any\s+)?(?:safety|security|permission|sandbox|approval|guardrail)s?\s+(?:checks?|prompts?|rules|policy|policies|restrictions|mode|settings?)\b/i),
  rule("policy-override.no-verify", "medium", "Skips git hooks or changes where they run",
    /\s--no-verify\b|\bcore\.hooksPath=/i),
  rule("policy-override.agent-config", "medium", "Writes to the settings of an agent or to git hooks",
    /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i)[^\n]{0,80}(?:\.claude\/settings(?:\.local)?\.json|\.codex\/config\.toml|\.git\/hooks\/)/i),
  rule("policy-override.without-asking", "low", "Tells the agent to act without asking",
    /\bwithout\s+(?:asking|confirmation|approval|permission)\b/i),

  // unsafe-network
  rule("unsafe-network.reverse-shell", "high", "Opens a shell over the network",
    /\/dev\/(?:tcp|udp)\/|\b(?:nc|ncat|netcat)\b[^\n]{0,40}\s-[a-z]{0,3}e\b|\bbash\s+-i\s+>&|\bsocat\b[^\n]{0,80}\bexec:/i),
  rule("unsafe-network.upload-secret-file", "high", "Uploads a file that holds credentials",
    /(?:--data(?:-binary|-raw)?|--upload-file|--post-file|\s-[dFT])[= ]\s{0,3}@?[^\s]{0,60}(?:\.ssh\/|\.aws\/|\.env\b|id_rsa|\/etc\/passwd)/i),
  rule("unsafe-network.raw-ip", "medium", "Uses a web address that is a raw IP address",
    /\bhttps?:\/\/(?!127\.|0\.0\.0\.0)(?:\d{1,3}\.){3}\d{1,3}\b/i),
  rule("unsafe-network.no-tls-check", "medium", "Turns off the check of a TLS certificate",
    /\bcurl\b[^\n|;]{0,80}\s(?:-[a-z]{0,6}k[a-z]{0,6}|--insecure)\b|\bwget\b[^\n|;]{0,80}--no-check-certificate\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s{0,4}=\s{0,4}["']?0|\bGIT_SSL_NO_VERIFY\b|\bverify\s{0,4}=\s{0,4}False\b|\bstrict-ssl\s+false\b/i),
  rule("unsafe-network.tunnel", "medium", "Names a tunnel or a service that catches or hosts data",
    /\b(?:ngrok|localtunnel|cloudflared\s+tunnel|serveo\.net|webhook\.site|requestbin|pastebin\.com|transfer\.sh|interact\.sh|burpcollaborator)\b/i),
  rule("unsafe-network.plain-http", "low", "Uses a web address without TLS",
    /\bhttp:\/\/(?!localhost\b|127\.|0\.0\.0\.0|\[::1\]|(?:[\w-]{1,63}\.){0,4}(?:example\.(?:com|org|net)|example|test|invalid|localhost)(?![\w.-]))[^\s"'<>)\]]{1,120}/i),

  // destructive-action
  rule("destructive-action.wipe-root", "high", "Deletes or overwrites a whole disk or the home folder",
    /\brm\s+(?:-[a-z]{1,8}\s+|--[a-z-]{1,24}\s+){1,4}["']?(?:\/\*|~\/\*|\/|~|\$HOME|\$\{HOME\})["']?(?![\w.\/*-])|--no-preserve-root\b|\bmkfs(?:\.\w{1,10})?\s|\bdd\b[^\n]{0,60}\bof=\/dev\/(?:sd|nvme|disk|hd)|:\(\)\s{0,2}\{\s{0,2}:\|:&\s{0,2}\};:/i),
  rule("destructive-action.git-history", "medium", "Rewrites or discards git history",
    /\bgit\s+push\b[^\n;|&]{0,80}\s(?:--force(?:-with-lease)?|-f)\b|\bgit\s+reset\s+--hard\b|\bgit\s+filter-(?:branch|repo)\b/i),
  rule("destructive-action.drop-data", "medium", "Drops or empties data",
    /\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b|\bDELETE\s+FROM\s+\w{1,64}\s{0,4};/i),
  rule("destructive-action.open-permissions", "medium", "Gives every user access to files",
    /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/i),
  rule("destructive-action.recursive-delete", "low", "Deletes files recursively",
    /\brm\s+-[a-z]{0,6}r[a-z]{0,6}\b[^\n]{0,80}|\brm\s+--recursive\b[^\n]{0,80}|\bRemove-Item\b[^\n]{0,60}-Recurse\b|\bshutil\.rmtree\b|\bgit\s+clean\s+-[a-z]{0,4}f/i),

  // hidden-dependency
  rule("hidden-dependency.download-run", "high", "Pipes a download into a shell or an interpreter",
    /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,200}\|\s{0,4}(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|python[0-9.]{0,4}|node|perl|ruby)\b|\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s{0,4}(?:curl|wget)\b|\b(?:ba|z)?sh\s+<\(\s{0,4}(?:curl|wget)\b|\b(?:iex|Invoke-Expression)\b[^\n]{0,40}\b(?:iwr|Invoke-WebRequest|DownloadString)\b/i),
  rule("hidden-dependency.install-remote", "medium", "Installs a package from a web address or a git source",
    /\bpip[0-9.]{0,4}\s+install\b[^\n]{0,80}(?:git\+|https?:\/\/|--index-url|--extra-index-url)|\bnpm\s+(?:install|i|add)\b[^\n]{0,80}(?:git\+|https?:\/\/|github:)|\bgo\s+install\b[^\n]{0,80}@latest|\bcargo\s+install\s+--git\b/i),
  rule("hidden-dependency.install-hook", "medium", "Defines an install hook",
    /"(?:pre|post)?install"\s{0,4}:\s{0,4}"/i),
  rule("hidden-dependency.install", "low", "Installs a package",
    /\b(?:pip[0-9.]{0,4}|pipx|uv\s+pip)\s+install\b[^\n]{0,80}|\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b[^\n]{0,80}|\b(?:apt|apt-get|yum|dnf|apk|brew|gem|cargo)\s+(?:install|add)\b[^\n]{0,80}|\bnpx\s+(?:-y\s+|--yes\s+)?[@\w][^\s]{0,80}/i),

  // path-escape
  rule("path-escape.parent-chain", "high", "Climbs out of the folder with several parent steps",
    /(?:\.\.[\/\\]){2,8}[^\s"'`)]{0,80}/i, "script"),
  rule("path-escape.parent", "medium", "Reaches a file outside the folder",
    /(?<!\.\.[\/\\])\.\.[\/\\](?!\.\.[\/\\])[^\s"'`)]{0,80}/i, "script"),
  rule("path-escape.system-path", "medium", "Uses a path in a system folder",
    /(?<![\w.$}~-])\/(?:etc|root|var\/run|proc|sys|boot|usr\/local\/bin|Library\/LaunchAgents)\/[\w.\/-]{1,80}/i, "script"),
  rule("path-escape.shell-profile", "medium", "Uses a shell profile or an agent folder in the home folder",
    /(?:~|\$HOME|\$\{HOME\})\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile|gitconfig|claude\/|codex\/)[\w.\/-]{0,60}/i),

  // obfuscation
  rule("obfuscation.eval-decoded", "high", "Runs decoded content",
    /\bbase64\s+(?:-d|-D|--decode)\b[^\n|]{0,80}\|\s{0,4}(?:sudo\s+)?(?:ba|z)?sh\b|\beval\s*\(\s{0,4}(?:atob|Buffer\.from|base64\.b64decode|bytes\.fromhex|unescape)\s*\(|\bexec\s*\(\s{0,4}(?:base64\.b64decode|bytes\.fromhex|codecs\.decode|zlib\.decompress)\s*\(|\beval\s+["']?\$\(\s{0,4}(?:echo\b[^\n|]{0,200}\|\s{0,4})?base64\b|\b(?:iex|Invoke-Expression)\b[^\n]{0,80}\bFromBase64String\b|\bpowershell\b[^\n]{0,40}\s-e(?:nc|ncodedcommand)?\s/i),
  rule("obfuscation.dynamic-eval", "medium", "Runs code built at run time",
    /\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s{0,4}compile\s*\(|__import__\s*\(/i, "script"),
  rule("obfuscation.encoded-blob", "medium", "Holds a long encoded block", /(?<![A-Za-z0-9+\/=])[A-Za-z0-9+\/]{200,}={0,2}/i, "any", false),
  rule("obfuscation.escaped-bytes", "medium", "Holds a long run of escaped bytes", /(?:\\x[0-9a-f]{2}){40,}/i, "any", false),
];
