let csrf = "";
/** The CSRF token of the signed-in session; sent with every call that is not a GET. */
export const setCsrf = (t) => {
  csrf = t || "";
};

export const PREVIEW_TEXT = "This is a preview. Nothing can be changed here.";
export const VIEW_ENDED_TEXT = "The view has ended.";

let viewAs = "";
let viewEnded = false;
let onViewEnded = null;
/** Starts (or, with "", stops) the read-only preview of one user's display. `onEnded` runs once, when the server refuses the view. */
export const setViewAs = (id, onEnded) => {
  viewAs = id || "";
  viewEnded = false;
  onViewEnded = onEnded || null;
};

/** The URL with `as=<id>` while a preview runs; `?` or `&` as the URL needs. */
export const withAs = (url) => (viewAs ? `${url}${url.includes("?") ? "&" : "?"}as=${encodeURIComponent(viewAs)}` : url);

/**
 * `stay`: a 401 does not reload the page (a typing save must not throw the typed text away).
 * `plain`: a call about the admin's own session or the view itself: no `as=`, allowed in a preview.
 * In a preview every other call is a GET with `as=`, and anything else throws before `fetch`.
 * A 403 there means the view has ended: the user display only makes calls the server allows a user, so no other 403 can happen.
 */
async function req(method, url, body, stay = false, plain = false) {
  const preview = Boolean(viewAs) && !plain;
  if (preview && method !== "GET") throw Object.assign(new Error(PREVIEW_TEXT), { preview: true });
  if (preview && viewEnded) throw Object.assign(new Error(VIEW_ENDED_TEXT), { status: 403 });
  if (preview) url = withAs(url);
  const headers = body ? { "content-type": "application/json" } : {};
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  // the session ended (expired, revoked, password changed): start again at the sign-in page
  if (r.status === 401 && !stay && !url.startsWith("/api/session")) location.reload();
  if (preview && r.status === 403 && !viewEnded) {
    viewEnded = true;
    onViewEnded?.();
  }
  if (!r.ok) throw Object.assign(new Error(data.error || `${r.status} ${r.statusText}`), { status: r.status, data });
  return data;
}

const enc = encodeURIComponent;

/** The audit filters as a query: only the ones that are set, in the order user, action, from, to. "" for none. */
const auditQuery = (f = {}) => {
  const q = ["user", "action", "from", "to"].filter((k) => f[k]).map((k) => `${k}=${enc(f[k])}`).join("&");
  return q ? `?${q}` : "";
};

export const api = {
  session: () => req("GET", "/api/session", undefined, false, true),
  signIn: (email, password) => req("POST", "/api/session", { email, password }),
  setPassword: (token, password) => req("POST", "/api/set-password", { token, password }),
  changePassword: (current, password) => req("POST", "/api/password", { current, password }),
  signOut: () => req("DELETE", "/api/session", undefined, false, true),
  startViewAs: (userId) => req("POST", "/api/admin/view-as", { userId }, false, true),
  stopViewAs: () => req("DELETE", "/api/admin/view-as", undefined, false, true),
  setup: (name, email, password) => req("POST", "/api/setup", { name, email, password }),
  info: () => req("GET", "/api/info"),
  flows: (published) => req("GET", published ? "/api/flows?published=1" : "/api/flows"),
  flow: (name) => req("GET", `/api/flows/${enc(name)}`),
  saveFlow: (name, yaml, scope) => req("PUT", `/api/flows/${enc(name)}`, { yaml, scope }),
  deleteFlow: (name) => req("DELETE", `/api/flows/${enc(name)}`),
  blocks: () => req("GET", "/api/blocks"),
  saveBlock: (id, yaml, scope) => req("PUT", `/api/blocks/${enc(id)}`, { yaml, scope }),
  deleteBlock: (id) => req("DELETE", `/api/blocks/${enc(id)}`),
  validate: (yaml) => req("POST", "/api/validate", { yaml }),
  generate: (request, current) => req("POST", "/api/generate", { request, current }),
  runs: (owner) => req("GET", owner ? `/api/runs?owner=${enc(owner)}` : "/api/runs"),
  runOwners: () => req("GET", "/api/run-owners"),
  run: (id) => req("GET", `/api/runs/${enc(id)}`),
  startRun: (body) => req("POST", "/api/runs", body),
  cancelRun: (id) => req("POST", `/api/runs/${enc(id)}/cancel`, {}),
  resumeRun: (id, from) => req("POST", `/api/runs/${enc(id)}/resume`, { from }),
  approveRun: (id, note) => req("POST", `/api/runs/${enc(id)}/approve`, { note }),
  rejectRun: (id, note) => req("POST", `/api/runs/${enc(id)}/reject`, { note }),
  answerRun: (id, text) => req("POST", `/api/runs/${enc(id)}/answer`, { text }),
  transcript: (id, n) => req("GET", `/api/runs/${enc(id)}/transcript/${n}`),
  diff: (id) => req("GET", `/api/runs/${enc(id)}/diff`),
  repos: () => req("GET", "/api/repos"),
  repoMethods: () => req("GET", "/api/repos/methods"),
  addRepo: (body) => req("POST", "/api/repos", body),
  setRepoAuth: (id, body) => req("PUT", `/api/repos/${enc(id)}/auth`, body),
  testRepo: (id) => req("POST", `/api/repos/${enc(id)}/test`, {}),
  repoReady: (id) => req("GET", `/api/repos/${enc(id)}/ready`),
  removeRepo: (id) => req("DELETE", `/api/repos/${enc(id)}`),
  users:() => req("GET", "/api/users"),
  addUser: (body) => req("POST", "/api/users", body),
  saveUser: (id, body) => req("PUT", `/api/users/${enc(id)}`, body),
  blockUser: (id, stopWork) => req("POST", `/api/users/${enc(id)}/block`, { stopWork: !!stopWork }),
  unblockUser: (id) => req("POST", `/api/users/${enc(id)}/unblock`, {}),
  resetUser: (id) => req("POST", `/api/users/${enc(id)}/reset`, {}),
  unlockUser: (id) => req("POST", `/api/users/${enc(id)}/unlock`, {}),
  userAppRepos: (id) => req("GET", `/api/users/${enc(id)}/app-repos`),
  setUserAppRepos: (id, repos) => req("PUT", `/api/users/${enc(id)}/app-repos`, { repos }),
  userLink: (id) => req("POST", `/api/users/${enc(id)}/link`, {}),
  limits: () => req("GET", "/api/users/limits"),
  saveDefaultLimits: (body) => req("PUT", "/api/users/limits", body),
  saveUserLimits: (id, body) => req("PUT", `/api/users/${enc(id)}/limits`, body),
  deleteUser: (id) => req("DELETE", `/api/users/${enc(id)}`),
  audit: (filters) => req("GET", `/api/audit${auditQuery(filters)}`),
  auditExportUrl: (filters) => `/api/audit/export${auditQuery(filters)}`,
  allRepos: () => req("GET", "/api/admin/repos"),
  setRepoSettings: (id, body) => req("PUT", `/api/admin/repos/${enc(id)}/settings`, body),
  setRepoReady: (id, body) => req("PUT", `/api/admin/repos/${enc(id)}/ready`, body),
  transferRepo: (id, email) => req("POST", `/api/admin/repos/${enc(id)}/transfer`, { email }),
  addRepoWatcher: (repoId, body) => req("POST", `/api/admin/repos/${enc(repoId)}/watchers`, body),
  saveRepoWatcher: (repoId, id, body) => req("PUT", `/api/admin/repos/${enc(repoId)}/watchers/${enc(id)}`, body),
  removeRepoWatcher: (repoId, id) => req("DELETE", `/api/admin/repos/${enc(repoId)}/watchers/${enc(id)}`),
  allCredentials: () => req("GET", "/api/admin/credentials"),
  refinement: () => req("GET", "/api/refinement"),
  createRefinement: (body) => req("POST", "/api/refinement", body),
  refinementBacklog: (repo) => req("GET", `/api/refinement/backlog?repo=${enc(repo)}`),
  refinementSession: (id) => req("GET", `/api/refinement/${enc(id)}`),
  renameRefinement: (id, body) => req("PUT", `/api/refinement/${enc(id)}`, body),
  dropRefinement: (id) => req("POST", `/api/refinement/${enc(id)}/drop`, {}),
  restoreRefinement: (id) => req("POST", `/api/refinement/${enc(id)}/restore`, {}),
  removeBuildLabel: (id) => req("POST", `/api/refinement/${enc(id)}/source/remove-build-label`, {}),
  askArchitect: (id) => req("POST", `/api/refinement/${enc(id)}/architect`, {}),
  askRound: (id) => req("POST", `/api/refinement/${enc(id)}/round`, {}),
  askOwnQuestion: (id, question) => req("POST", `/api/refinement/${enc(id)}/ask`, { question }),
  answerQuestion: (id, qid, body) => req("POST", `/api/refinement/${enc(id)}/questions/${enc(qid)}/answer`, body),
  acceptProposal: (id, pid) => req("POST", `/api/refinement/${enc(id)}/proposals/${enc(pid)}/accept`, {}),
  rejectProposal: (id, pid) => req("POST", `/api/refinement/${enc(id)}/proposals/${enc(pid)}/reject`, {}),
  changeMapEntry: (id, eid, text) => req("PUT", `/api/refinement/${enc(id)}/map/${enc(eid)}`, { text }),
  removeMapEntry: (id, eid) => req("DELETE", `/api/refinement/${enc(id)}/map/${enc(eid)}`),
  addDraft: (id) => req("POST", `/api/refinement/${enc(id)}/drafts`, {}),
  saveDraft: (id, did, body) => req("PUT", `/api/refinement/${enc(id)}/drafts/${enc(did)}`, body, true),
  removeDraft: (id, did) => req("DELETE", `/api/refinement/${enc(id)}/drafts/${enc(did)}`),
  // `stay`: a 401 must not reload the page while another field holds text that is not saved
  suggestField: (id, did, field) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/suggest`, { field }, true),
  acceptSuggestion: (id, did, xid, body = {}) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/suggestions/${enc(xid)}/accept`, body, true),
  reviewDraft: (id, did) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/review`, {}, true),
  checkReady: (id, did) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/ready-check`, {}, true),
  acceptAnyway: (id, did, item, reason) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/ready/${enc(item)}/accept`, { reason }, true),
  removeAccepted: (id, did, item) => req("DELETE", `/api/refinement/${enc(id)}/drafts/${enc(did)}/ready/${enc(item)}/accept`, undefined, true),
  askImpact: (id, did) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/impact`, {}, true),
  askSplit: (id, did, own) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/split`, own ? { own } : {}, true),
  confirmSplit: (id, did, body) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/split/confirm`, body, true),
  moveCriterion: (id, did, cid, to) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/criteria/${enc(cid)}/move`, { to }, true),
  mergeDrafts: (id, did, other) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/merge`, { with: other }, true),
  setReviewLabel: (id, did, add) => req("PUT", `/api/refinement/${enc(id)}/drafts/${enc(did)}/review-label`, { add: Boolean(add) }, true),
  moveToNotes: (id, did, body) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/move-to-notes`, body, true),
  rejectSuggestion: (id, did, xid, body = {}) => req("POST", `/api/refinement/${enc(id)}/drafts/${enc(did)}/suggestions/${enc(xid)}/reject`, body, true),
  publishPlan: (id) => req("GET", `/api/refinement/${enc(id)}/publish`),
  publish: (id, body) => req("POST", `/api/refinement/${enc(id)}/publish`, body),
  setEpic: (id, issue) => req("PUT", `/api/refinement/${enc(id)}/epic`, { issue }),
  queue: () => req("GET", "/api/queue"),
  config: () => req("GET", "/api/config"),
  saveConfig: (config) => req("PUT", "/api/config", config),
  watchers: () => req("GET", "/api/watchers"),
  monitor: () => req("GET", "/api/monitor"),
  monitorOff: () => req("POST", "/api/monitor/off", {}),
  monitorOn: () => req("POST", "/api/monitor/on", {}),
  muteMonitor: (body) => req("POST", "/api/monitor/mutes", body),
  monitorFinding: (id) => req("GET", "/api/monitor/findings/" + enc(id)),
  monitorStory: (finding) => req("POST", "/api/monitor/story", { finding }),
  retryMonitor: (finding) => req("POST", "/api/monitor/retry", { finding }),
  unmuteMonitor: (id) => req("DELETE", `/api/monitor/mutes/${enc(id)}`),
  tickWatcher:(id) => req("POST", `/api/watchers/${enc(id)}/tick`, {}),
  providers: () => req("GET", "/api/providers"),
  testModel: (spec) => req("POST", "/api/providers/test", { spec }),
  next: () => req("GET", "/api/next"),
  health: () => req("GET", "/api/health"),
  yourTurn: () => req("GET", "/api/your-turn"),
  since: (from) => req("GET", `/api/since?since=${enc(from)}`),
  dismissTurn: (key) => req("POST", "/api/your-turn/dismiss", { key }),
  // Without a key every dismissed item comes back; only a missing key means "all".
  restoreTurn: (key) => req("POST", "/api/your-turn/restore", key === undefined ? {} : { key }),
  turnDetail: (key) => req("GET", `/api/your-turn/detail?key=${enc(key)}`),
  actTurn: (body) => req("POST", "/api/your-turn/act", body),
  clarity: () => req("GET", "/api/clarity"),
  board: () => req("GET", "/api/board"),
  stats: () => req("GET", "/api/stats"),
  evals: () => req("GET", "/api/evals"),
  clean: (opts) => req("POST", "/api/clean", opts),
  events: (id) => {
    if (viewAs && viewEnded) throw Object.assign(new Error(VIEW_ENDED_TEXT), { status: 403 });
    return new EventSource(withAs(`/api/runs/${enc(id)}/events`));
  },
};
