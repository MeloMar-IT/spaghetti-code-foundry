/** Shown when server.public_url is refused. */
export const PUBLIC_URL_MESSAGE = "must be an https address without user, password, ? or #";

const SAFE_CHARS = /^https:\/\/[^\s()<>"'`|\\]+$/;
const SAFE_PAGE = /^#\/[\w\-./%]*$/;

/** An https address for links: no user, password, query, fragment, whitespace or markdown/Slack-breaking characters. */
export function isPublicUrl(s: string): boolean {
  if (s.length > 2048 || !SAFE_CHARS.test(s)) return false;
  if (!URL.canParse(s)) return false;
  const u = new URL(s);
  return u.protocol === "https:" && !u.username && !u.password && u.hostname !== "" && !u.search && !u.hash && !s.includes("?") && !s.includes("#");
}

/** The base for links without trailing slashes; undefined when not set or empty. */
export function appBase(url: string | undefined): string | undefined {
  const b = url?.trim().replace(/\/+$/, "");
  return b ? b : undefined;
}

/** `${base}/${page}` for a page "#/…" of safe characters; undefined otherwise or without a base. */
export function appLink(base: string | undefined, page: string | undefined): string | undefined {
  if (!base || !page || !SAFE_PAGE.test(page)) return undefined;
  return `${base}/${page}`;
}
