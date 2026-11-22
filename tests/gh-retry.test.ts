import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghReadOnly, ghRetryDelays, retryableGhError } from "../src/gh-retry.js";
import { gh, ghJson, withGhEnv, type GhSession } from "../src/github.js";
import { fakeGithub } from "./helpers/fake-github.js";

const Q = JSON.stringify({ query: "query($o:String!){ repository(owner:$o){ id } }" });

describe("ghReadOnly", () => {
  it("is true for reads", () => {
    for (const args of [
      ["api", "rate_limit"],
      ["api", "repos/o/r/issues?x"],
      ["api", "--paginate", "repos/o/r/labels?per_page=100", "--jq", ".[].name"],
      ["api", "-X", "GET", "search/issues", "-f", "q=x"],
      ["api", "--method=get", "search/issues", "--raw-field=q=x"],
      ["api", "graphql", "-F", "n=1", "-f", "query=query($n:Int){ viewer { login } }"],
      ["api", "graphql", "--raw-field=query={ viewer { login } }"],
      ["issue", "view", "1"], ["issue", "list"], ["pr", "view", "1"], ["pr", "list"], ["repo", "view", "a/b"], ["label", "list"],
    ]) expect(ghReadOnly(args), args.join(" ")).toBe(true);
    expect(ghReadOnly(["api", "graphql", "--input", "-"], Q)).toBe(true);
  });

  it("is false for writes and for what it cannot tell", () => {
    for (const args of [
      ["api", "-X", "PATCH", "repos/o/r/issues/1", "--input", "-"],
      ["api", "-XPOST", "repos/o/r/issues"],
      ["api", "--method", "DELETE", "repos/o/r/issues/1"],
      ["api", "--method=PUT", "repos/o/r/x"],
      ["api", "repos/o/r/issues", "--input", "-"],
      ["api", "repos/o/r/issues", "--input=-"],
      ["api", "repos/o/r/issues", "-f", "title=x"],
      ["api", "repos/o/r/issues", "-ftitle=x"],
      ["api", "repos/o/r/issues", "-Ftitle=x"],
      ["api", "repos/o/r/issues", "--raw-field=title=x"],
      ["api", "repos/o/r/issues", "--field", "title=x"],
      ["api", "graphql"],
      ["api", "graphql", "-f", "query=mutation{ x }"],
      ["issue", "comment", "1"], ["issue", "edit", "1"], ["issue", "create"], ["issue", "close", "1"], ["pr", "comment", "1"],
      ["pr", "merge", "1"], ["pr", "ready", "1"], ["label", "create", "x"], ["pr", "checks", "1"], ["repo", "create", "x"], [],
    ]) expect(ghReadOnly(args), args.join(" ")).toBe(false);
  });

  it("is false for a GraphQL document that holds a mutation next to a query, or whose query is unclear", () => {
    const two = JSON.stringify({ query: "query A { viewer { login } } mutation B { addComment(input:{}) { clientMutationId } }", operationName: "B" });
    expect(ghReadOnly(["api", "graphql", "--input", "-"], two)).toBe(false);
    expect(ghReadOnly(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation{ x }" }))).toBe(false);
    expect(ghReadOnly(["api", "graphql", "--input", "-"], "not json")).toBe(false);
    expect(ghReadOnly(["api", "graphql", "--input", "-"], JSON.stringify({ variables: {} }))).toBe(false);
    expect(ghReadOnly(["api", "graphql", "--input", "-", "-f", "query=query{ a }"], Q)).toBe(false); // two queries
  });
});

describe("ghRetryDelays", () => {
  const was = process.env.FACTORY_GH_RETRY_MS;
  afterEach(() => {
    if (was === undefined) delete process.env.FACTORY_GH_RETRY_MS;
    else process.env.FACTORY_GH_RETRY_MS = was;
  });

  it("is 1 s and 3 s by default, and takes the override", () => {
    delete process.env.FACTORY_GH_RETRY_MS;
    expect(ghRetryDelays()).toEqual([1000, 3000]);
    process.env.FACTORY_GH_RETRY_MS = "10,10";
    expect(ghRetryDelays()).toEqual([10, 10]);
    process.env.FACTORY_GH_RETRY_MS = "5,x,,-1,7";
    expect(ghRetryDelays()).toEqual([5, 7]);
  });

  it("never allows more than 2 retries", () => {
    process.env.FACTORY_GH_RETRY_MS = "1,2,3,4,5";
    expect(ghRetryDelays()).toEqual([1, 2]);
  });
});

describe("retryableGhError", () => {
  it("is true for a temporary error, false for a killed call or a refusal", () => {
    expect(retryableGhError({ killed: true, stderr: "HTTP 502" })).toBe(false);
    expect(retryableGhError({ stderr: "gh: HTTP 499" })).toBe(true);
    expect(retryableGhError({ message: "Command failed: gh x\nunexpected EOF" })).toBe(true);
    expect(retryableGhError({ message: "Command failed: gh x\nHTTP 404: Not Found" })).toBe(false);
    expect(retryableGhError({ message: "Command failed: gh issue list --search timeout" })).toBe(false); // only the diagnostic counts
    expect(retryableGhError(undefined)).toBe(false);
  });
});

describe("gh() retries", () => {
  let fake: ReturnType<typeof fakeGithub>;
  beforeEach(() => { fake = fakeGithub(); });
  afterEach(() => fake.restore());
  const calls = (re: string) => fake.ghLog().split("\n").filter((l) => new RegExp(`^gh ${re}`).test(l)).length;
  const LIST = ["issue", "list", "--repo", "acme/app", "--json", "number"];

  it("a read that fails once with HTTP 499 returns its result", async () => {
    Object.assign(process.env, { FAKE_GH_FAIL: "issue list", FAKE_GH_FAIL_TEXT: "gh: HTTP 499 (https://api.github.com/graphql)", FAKE_GH_FAIL_TIMES: "1", FAKE_GH_ISSUES: "[]" });
    await expect(ghJson(LIST)).resolves.toEqual([]);
    expect(calls("issue list")).toBe(2);
  });

  it("a read that keeps failing with HTTP 502 is called 3 times, then rejects", async () => {
    Object.assign(process.env, { FAKE_GH_FAIL: "issue list", FAKE_GH_FAIL_TEXT: "HTTP 502: Bad Gateway" });
    await expect(gh(LIST)).rejects.toMatchObject({ stderr: expect.stringContaining("HTTP 502") });
    expect(calls("issue list")).toBe(3);
  });

  it("a refusal or a rate limit is called once, and its error is unchanged", async () => {
    for (const text of ["HTTP 401: Bad credentials", "HTTP 403: Forbidden", "HTTP 404: Not Found", "HTTP 422: Unprocessable", "HTTP 403: API rate limit exceeded", "secondary rate limit HTTP 502"]) {
      Object.assign(process.env, { FAKE_GH_FAIL: "issue list", FAKE_GH_FAIL_TEXT: text });
      const before = calls("issue list");
      await expect(gh(LIST)).rejects.toMatchObject({ stderr: `${text}\n` });
      expect(calls("issue list") - before, text).toBe(1);
    }
  });

  it("a call that changes something is called once", async () => {
    process.env.FAKE_GH_FAIL_TEXT = "gh: HTTP 499";
    const writes: [string, string[]][] = [
      ["issue comment", ["issue", "comment", "1", "--repo", "acme/app", "--body", "x"]],
      ["issue edit", ["issue", "edit", "1", "--repo", "acme/app", "--add-label", "x"]],
      ["api -X PATCH", ["api", "-X", "PATCH", "repos/acme/app/issues/1", "--input", "-"]],
      ["api -X POST", ["api", "-X", "POST", "repos/acme/app/issues", "--input", "-"]],
      ["api -X DELETE", ["api", "-X", "DELETE", "repos/acme/app/issues/1"]],
      ["api repos/acme/app/issues", ["api", "repos/acme/app/issues", "--raw-field=title=x"]],
      ["api graphql", ["api", "graphql", "--input", "-"]],
    ];
    for (const [on, args] of writes) {
      process.env.FAKE_GH_FAIL_ON = on;
      const before = fake.ghLog().split("\n").length;
      const input = on === "api graphql" ? JSON.stringify({ query: "query A { viewer { login } } mutation B { x }", operationName: "B" }) : "{}";
      await expect(gh(args, undefined, undefined, input), on).rejects.toBeDefined();
      expect(fake.ghLog().split("\n").length - before, on).toBe(1);
    }
  });

  it("a GraphQL query is retried", async () => {
    Object.assign(process.env, { FAKE_GH_FAIL_ON: "api graphql", FAKE_GH_FAIL_TEXT: "gh: HTTP 499", FAKE_GH_FAIL_TIMES: "1" });
    await gh(["api", "graphql", "--input", "-"], undefined, undefined, Q).catch(() => undefined);
    expect(calls("api graphql")).toBe(2);
  });

  it("a dropped connection reported without an error code is retried", async () => {
    Object.assign(process.env, {
      FAKE_GH_FAIL: "issue list",
      FAKE_GH_FAIL_TEXT: "read tcp 10.0.0.2:51234->140.82.112.6:443: read: connection reset by peer",
      FAKE_GH_FAIL_TIMES: "1",
      FAKE_GH_ISSUES: "[]",
    });
    await expect(ghJson(LIST)).resolves.toEqual([]);
    expect(calls("issue list")).toBe(2);
  });

  it("a call killed by its own time limit is not retried", async () => {
    process.env.FAKE_GH_SLEEP = "1";
    await expect(gh(["api", "rate_limit"], undefined, 100)).rejects.toMatchObject({ killed: true });
    expect(calls("api rate_limit")).toBe(1);
  });

  it("the time limit is one budget for all tries: no try starts when its wait does not fit", async () => {
    process.env.FACTORY_GH_RETRY_MS = "300,600";
    Object.assign(process.env, { FAKE_GH_FAIL: "api rate_limit", FAKE_GH_FAIL_TEXT: "gh: HTTP 502" });
    await expect(gh(["api", "rate_limit"], undefined, 700)).rejects.toBeDefined();
    expect(calls("api rate_limit")).toBe(2); // the second wait (600 ms) does not fit in what is left
  });

  it("the token is still cleaned from the last error", async () => {
    const token = "tok-" + "z9".repeat(10);
    const session: GhSession = { env: { GH_TOKEN: token, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined }, stamp: token };
    Object.assign(process.env, { FAKE_GH_FAIL: "issue list", FAKE_GH_FAIL_TEXT: `HTTP 502 ${token}` });
    const e = await withGhEnv(session, () => gh(LIST)).catch((x: Error & { stderr?: string }) => x);
    expect(calls("issue list")).toBe(3);
    expect(JSON.stringify([e.message, e.stderr])).not.toContain(token);
    expect(e.stderr).toContain("[redacted]");
  });
});
