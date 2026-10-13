// How an external connection is shown everywhere: provider, identity (who the Foundry acts as) and scope (what it may do).
// Pure: no DOM and no imports. The texts never contain a secret; a deploy key is shown by its type and comment only.

const HOST_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)/i;
const SLUG_RE = /^https:\/\/github\.com\/apps\/([A-Za-z0-9-]+)\/installations\/new$/;
const CHECKS = [["clone", "Read"], ["push", "Write"], ["github-api", "GitHub API"]];
const BOUND = "limited to this repository";

/** "GitHub" for github.com (case ignored), else the lower-case host name, else "Unknown host". */
export function providerOf(url) {
  const m = typeof url === "string" ? HOST_RE.exec(url.trim()) : null;
  if (!m) return "Unknown host";
  const host = m[1].toLowerCase();
  return host === "github.com" ? "GitHub" : host;
}

/** The slug of github.com/apps/<slug>/installations/new, or "". */
export function appSlug(options) {
  const url = options?.githubApp?.installUrl;
  return typeof url === "string" ? SLUG_RE.exec(url)?.[1] ?? "" : "";
}

function deployKeyIdentity(publicKey) {
  const words = typeof publicKey === "string" ? publicKey.trim().split(/\s+/).filter(Boolean) : [];
  if (!words.length) return "deploy key";
  return ["deploy key", words[0], ...words.slice(2)].join(" ");
}

function identityOf(repo, admin, options) {
  switch (repo.method) {
    case "github-app": return appSlug(options) ? `GitHub App ${appSlug(options)}` : "GitHub App";
    case "https-token": return repo.username ? `token of ${repo.username}` : "token";
    case "github-token": return "fine-grained token";
    case "ssh-deploy-key": return deployKeyIdentity(repo.publicKey);
    case "none": return admin ? "the server's own access" : "Needs authentication";
    default: return String(repo.method);
  }
}

function scopeOf(repo) {
  const checks = Array.isArray(repo.connection?.checks) ? repo.connection.checks : [];
  return CHECKS.map(([check, name]) => {
    const found = checks.find((c) => c?.check === check);
    return { name, state: !found || found.skipped ? "not checked" : found.ok ? "works" : "failed" };
  });
}

/** { provider, identity, scope: [{ name, state }], bound } of a repository record. */
export function integrationOf(repo, { admin = false, options } = {}) {
  const r = repo ?? {};
  return {
    provider: providerOf(r.url),
    identity: identityOf(r, admin, options),
    scope: scopeOf(r),
    bound: r.method === "ssh-deploy-key" || r.method === "github-app" ? BOUND : "",
  };
}

/** The three { label, value } items of a statusSummary: Provider, Identity, Scope. */
export function integrationBlock(info) {
  const scope = info.scope.map((s) => `${s.name} ${s.state}`).join(", ");
  const parts = [scope, info.bound].filter(Boolean);
  return [
    { label: "Provider", value: info.provider },
    { label: "Identity", value: info.identity },
    { label: "Scope", value: parts.length ? parts.join(", ") : "—" },
  ];
}

/**
 * The integration of a stored credential `repo:<id>`: that of its repository (same owner). `repos` is the list of
 * repositories, or anything else when it could not be loaded (the details are then said to be unavailable).
 */
export function credentialIntegration(cred, repos, options) {
  const own = `${cred?.type} ${cred?.name}`;
  if (!Array.isArray(repos)) return { provider: "Unavailable", identity: `Details unavailable (${own})`, scope: [], bound: "" };
  const repo = repos.find((r) => cred?.name === `repo:${r.id}` && r.owner === cred.owner);
  if (!repo) return { provider: "No repository", identity: own, scope: [], bound: "" };
  return integrationOf(repo, { admin: repo.account?.role === "admin", options });
}
