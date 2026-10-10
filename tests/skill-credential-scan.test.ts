import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_RULES,
  CREDENTIAL_RULE_NAMES,
  ENDPOINT_SCHEMES,
  KEY_DATA,
  PLACEHOLDER,
  RISKY_FILE,
  SAFE_FILE,
  credentialProblem,
  riskyFileName,
} from "../src/skills/credential-scan.js";

// Test data is built from pieces so that tools/secret-scan finds nothing in this file.
const url = (scheme: string, rest: string) => scheme + "://" + rest;
const TOKEN_SLUG = "sk-" + "ant-" + "abcdefghij" + "0123456789";
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";
const toolSource = readFileSync("tools/secret-scan", "utf8");

describe("parity with tools/secret-scan", () => {
  const block = toolSource.slice(toolSource.indexOf("const RULES = [") + "const RULES = [".length);
  const lines = block.slice(0, block.indexOf("];")).split("\n").filter((l) => l.trim());
  const parsed = lines.map((l) => {
    const m = /^\s*\["([^"]+)",\s*\/(.+)\/([a-z]*)\],?\s*$/.exec(l);
    expect(m, l).not.toBeNull();
    return { name: m![1]!, source: m![2]!, flags: m![3]! };
  });

  it("has the same 14 rules", () => {
    expect(parsed).toHaveLength(14);
    expect(parsed.map((r) => r.name)).toEqual(CREDENTIAL_RULES.map((r) => r[0]));
    for (const [i, r] of parsed.entries()) {
      const re = new RegExp(r.source, r.flags);
      expect(CREDENTIAL_RULES[i]![1].source).toBe(re.source);
      expect(CREDENTIAL_RULES[i]![1].flags).toBe(re.flags);
    }
  });

  it("has the same helper patterns", () => {
    const ours = { KEY_DATA, PLACEHOLDER, RISKY_FILE, SAFE_FILE };
    for (const [name, re] of Object.entries(ours)) {
      const m = new RegExp(`^const ${name} = \\/(.+)\\/([a-z]*);$`, "m").exec(toolSource);
      expect(m, name).not.toBeNull();
      const theirs = new RegExp(m![1]!, m![2]!);
      expect(re.source).toBe(theirs.source);
      expect(re.flags).toBe(theirs.flags);
    }
  });
});

describe("guard: the files of this feature pass the tool's line rules", () => {
  const files = [
    "src/skills/credential-scan.ts",
    "tests/skill-credential-scan.test.ts",
    "tests/skill-package-credentials.test.ts",
    "tests/skill-package.test.ts",
    "tests/skill-schema.test.ts",
    "tests/skill-registry.test.ts",
  ];
  it("no line trips a rule", () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((text, i) => {
        for (const [rule, re] of CREDENTIAL_RULES) {
          const m = re.exec(text);
          if (!m) continue;
          const value = m[1] ?? m[0];
          if (rule === "hard-coded secret" && (PLACEHOLDER.test(value) || !/[0-9]/.test(value) || !/[A-Za-z]/.test(value))) continue;
          hits.push(`${f}:${i + 1} ${rule}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("credentialProblem: hits", () => {
  const samples: [string, string][] = [
    ["private key", PEM + "\n" + "A".repeat(64)],
    ["AWS access key", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["AWS secret key", "aws_secret_access_key" + " = " + "A1b2C3d4E5".repeat(4)],
    ["GitHub token", "ghp_" + "a1B2c3D4e5".repeat(4)],
    ["Anthropic key", TOKEN_SLUG],
    ["OpenAI key", "sk-" + "proj-" + "A1b2C3d4E5".repeat(4)],
    ["Slack token", "xox" + "b-" + "1234567890" + "abcdef"],
    ["Slack webhook", "https://hooks." + "slack.com/services/" + "T0123ABCD/B0123ABCD/" + "abcdefghijklmnop"],
    ["Google API key", "AIza" + "A1b2C3d4E5".repeat(3) + "A1b2C"],
    ["Stripe live key", "sk_" + "live_" + "a1B2c3D4e5".repeat(3)],
    ["npm token", "npm_" + "a1B2c3D4e5".repeat(3) + "a1B2c3"],
    ["Linear key", "lin_api_" + "a1B2c3D4e5".repeat(4)],
    ["connection string with password", "jdbc:oracle:thin:scott/" + "tiger123" + "@//h:1521/x"],
    ["connection string with password", url("https", "user:" + "passw0rd1" + "@git.corp.net/r.git")],
    ["hard-coded secret", "api_key" + ' = "' + "abc123def456ghi" + '"'],
  ];
  it.each(samples)("%s", (rule, sample) => expect(credentialProblem(sample)).toBe(rule));

  it.each(["postgres", "postgresql", "mysql", "mongodb", "mongodb+srv", "redis", "amqp"])("connection string with password: %s", (s) => {
    expect(credentialProblem(url(s, "user:" + "s3cretpw" + "@db.corp.net/x"))).toBe("connection string with password");
  });

  it("every result is a known rule name", () => {
    for (const [, s] of samples) expect(CREDENTIAL_RULE_NAMES).toContain(credentialProblem(s));
  });
});

describe("credentialProblem: endpoints", () => {
  it("knows 22 schemes", () => {
    expect([...ENDPOINT_SCHEMES].sort()).toEqual(
      ["amqp", "amqps", "cassandra", "clickhouse", "db2", "kafka", "ldap", "ldaps", "mariadb", "mongodb", "mongodb+srv", "mqtt", "mqtts", "mysql", "nats", "postgres", "postgresql", "redis", "rediss", "sqlserver", "tcp", "tcps"],
    );
  });
  it.each([...ENDPOINT_SCHEMES])("scheme %s", (s) => {
    expect(credentialProblem(s + "://node1.corp.net:1234/x")).toBe("connection endpoint");
    expect(credentialProblem(s + "://<host>:1234")).toBeUndefined();
    expect(credentialProblem(s + "://db.example.com:1234")).toBeUndefined();
    expect(credentialProblem(s + "://localhost")).toBeUndefined();
  });

  const hits = [
    "kafka://kafka-prod-01.corp.net:9092",
    "KAFKA://Real.Corp.Net:9092",
    "amqps://mq.acme.io:5671",
    "kafka://kafka:9092",
    "redis://cache",
    "mongodb+srv://cluster0.ab1cd.mongodb.net/app",
    "postgres://app@db.corp.net/app",
    "postgres://user%40corp@db.corp.net/app",
    "postgres://${DB_USER}@db.corp.net/app",
    "redis://[2001:db8::5]:6379",
    "jdbc:sqlserver://sql01.corp;databaseName=x",
    "jdbc:oracle:thin:@//ora12.internal:1521/ORCL",
    "jdbc:oracle:thin:@ora12.internal:1521:ORCL",
    "jdbc:oracle:thin:@tcps://ora12.internal:2484/ORCL",
    "jdbc:oracle:thin:scott/${DB_PASSWORD}@//ora12.internal:1521/ORCL",
    "jdbc:oracle:thin:scott/${DB_PASSWORD}@ora12.internal:1521:ORCL",
    "jdbc:oracle:thin:${DB_USER}/${DB_PASSWORD}@//ora12.internal:1521/ORCL",
    url("postgres", "${DB_USER}:${DB_PASS}@db.corp.net:5432/app"),
    "kafka://real.corp.net).",
  ];
  it.each(hits)("hit: %s", (s) => expect(credentialProblem(s)).toBe("connection endpoint"));

  const clean = [
    "kafka://<broker>:9092",
    "redis://${REDIS_HOST}:6379",
    "amqp://mq.example.com",
    "kafka://localhost:9092",
    "kafka://host:9092",
    "postgres://hostname/app",
    "ldap://server",
    "kafka://broker:9092",
    "mysql://db/app",
    "nats://queue.example",
    "mqtt://x.test",
    "amqp://x.invalid",
    "nats://Sub.Example.ORG:4222",
    "mysql://db.internal.test/x",
    "mqtt://x.localhost",
    "redis://[::1]:6379",
    "redis://127.0.0.1",
    "ldap://192.0.2.7",
    "tcp://0.0.0.0:2375",
    "jdbc:oracle:thin:@host:1521:SID",
    "jdbc:h2:mem:test",
    "jdbc:postgresql:///db",
    "jdbc:sqlite:/data/app.db",
    "kafka://broker.",
    "kafka://%BROKER%:9092",
    "kafka://*:9092",
    "https://api.corp.net/v1",
    "git://git.corp.net/r.git",
    "org.apache.kafka://x",
    url("postgres", "user:<password>@localhost/app"),
    "postgres://user%40corp@localhost/app",
    url("postgres", "${DB_USER}:${DB_PASS}@${DB_HOST}:5432/app"),
    "jdbc:oracle:thin:scott/${DB_PASSWORD}@//host:1521/svc",
    "jdbc:oracle:thin:<user>/<password>@//<host>:1521/<service>",
    "jdbc:oracle:thin:@tcps://<host>:2484/svc",
    'password: "onlyletterslong"',
    'password: "123456789012"',
    PEM + " ".repeat(400) + "A".repeat(64),
  ];
  it.each(clean)("no hit: %s", (s) => expect(credentialProblem(s)).toBeUndefined());

  it("our own messages never trip the scan", () => {
    for (const r of CREDENTIAL_RULE_NAMES) {
      for (const m of [
        `holds what looks like a credential or a live endpoint (${r}); use a placeholder`,
        "is a credential file by its name; a skill must not hold credentials",
        `a file name looks like a credential (${r})`,
        `the folder name looks like a credential (${r})`,
      ])
        expect(credentialProblem(m)).toBeUndefined();
    }
  });
});

describe("credentialProblem: later match wins", () => {
  it("a real endpoint after a placeholder", () => {
    expect(credentialProblem("kafka://<broker>:9092 or kafka://real.corp.net:9092")).toBe("connection endpoint");
  });
  it("a real value after a placeholder", () => {
    expect(credentialProblem('password: "${DB_PASSWORD}"\npassword: "' + "realvalue1234" + '"')).toBe("hard-coded secret");
  });
  it("a PEM header with key data after one without", () => {
    expect(credentialProblem(PEM + " ".repeat(400) + PEM + "\n" + "A".repeat(64))).toBe("private key");
  });
});

describe("credentialProblem: speed", () => {
  it.each([
    ["a.".repeat(131072)],
    ["jdbc:".repeat(52000)],
    ["jdbc:oracle:thin:".repeat(15000)],
    ["ab://".repeat(52000)],
    ["password ".repeat(29000)],
  ])("crafted input %#", (text) => {
    const t = performance.now();
    credentialProblem(text);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("riskyFileName", () => {
  it.each([".env", "scripts/.env", "scripts/.env.production", "assets/server.pem", "assets/id_rsa", "assets/id_ed25519", "assets/a.p12", "assets/a.pfx", "assets/a.key", "assets/a.keystore", "assets/a.jks", "assets/SERVER.PEM"])(
    "true: %s",
    (p) => expect(riskyFileName(p)).toBe(true),
  );
  it.each(["references/key.pem.example", "scripts/.env.example", "scripts/.env.sample", "assets/id_rsa.pub", "assets/a.pem.template", "assets/a.key.dist", "references/keys.md", "references/environment.md", "scripts/a.sh"])(
    "false: %s",
    (p) => expect(riskyFileName(p)).toBe(false),
  );
});
