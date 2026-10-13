import { YAMLParseError } from "yaml";
import { ConfigIssuesError, type Config } from "../config.js";

type View = Omit<Config, "notify"> & { notify: Omit<Config["notify"], "slack_webhook"> & { slack_webhook_set: boolean } };

/** The settings as the API shows them: no Slack webhook, only whether one is set. */
export function configView(c: Config): View {
  const { slack_webhook, ...notify } = c.notify;
  return { ...c, notify: { ...notify, slack_webhook_set: typeof slack_webhook === "string" && slack_webhook !== "" } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body of a save with the stored webhook put back: no key keeps it, null removes it. Drops the marker. Never changes `body`. */
export function withStoredWebhook(body: unknown, stored: string | undefined): unknown {
  if (!isObj(body)) return body;
  if (body.notify !== undefined && !isObj(body.notify)) return body;
  const { slack_webhook_set: _marker, ...notify } = (body.notify ?? {}) as Record<string, unknown>;
  if ("slack_webhook" in notify) {
    if (notify.slack_webhook === null) delete notify.slack_webhook;
  } else if (stored !== undefined) {
    notify.slack_webhook = stored;
  }
  if (body.notify === undefined && !Object.keys(notify).length) return body;
  return { ...body, notify };
}

/** Why the stored file cannot be read, for an API answer. Never the YAML parser's own words: they quote the lines around the error. */
export function storedConfigProblem(e: unknown): string {
  if (e instanceof ConfigIssuesError) return e.message;
  const line = e instanceof YAMLParseError ? e.linePos?.[0]?.line : undefined;
  return `config.yaml is not valid YAML${line !== undefined ? ` (line ${line})` : ""}; fix the file by hand`;
}
