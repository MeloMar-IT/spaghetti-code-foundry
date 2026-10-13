// Reviewed, data-only profiles for known upstream skill repositories. No code, no imports.

export const CONNECTOR_REQUIREMENTS = ["prisma-cli", "prisma-generated-client"] as const;

export interface ConnectorSkillRule {
  /** Source-specific capability slugs. */
  specific: readonly string[];
  /** General guidance the skill also gives; other sources may provide the same. */
  general: readonly string[];
  /** Range of the ORM version in the project; absent: any. */
  orm?: string;
  /** Supported engines; empty: any engine. */
  engines: readonly string[];
  /** Range of the runtime; absent: any. */
  runtime?: string;
  requirements: readonly (typeof CONNECTOR_REQUIREMENTS)[number][];
  /** Evaluations that must have passed. Not empty: the skill is high risk. */
  evaluations: readonly string[];
  /** Upstream skills this one sends the reader to; all must be mapped and in the import. */
  companions: readonly string[];
}

export interface SourceConnector {
  id: string;
  profile: number;
  repositoryKey: string;
  /** Upstream commits (40 hex) this profile was checked against. */
  reviewed: readonly string[];
  category: string;
  technology: string;
  runtime: string;
  engines: readonly string[];
  /** Dependency names that prove the ORM, and dependency name → engine. */
  evidence: { orm: readonly string[]; engines: Readonly<Record<string, string>> };
  exclusive: readonly string[];
  highRisk: readonly string[];
  /** Text that marks guarded guidance, and the evaluations it then needs. */
  guard: { phrases: readonly string[]; evaluations: readonly string[] };
  /** Upstream skill name → rule. */
  skills: Readonly<Record<string, ConnectorSkillRule>>;
}

const MIGRATION = ["migration-no-data-loss", "migration-no-production-reset", "migration-review-before-apply"] as const;
const SQL_ENGINES = ["postgresql", "mysql", "sqlite", "sqlserver", "cockroachdb"] as const;

export const PRISMA_CONNECTOR: SourceConnector = {
  id: "prisma",
  profile: 1,
  repositoryKey: "github.com/prisma/skills",
  // Upstream could not be read when this profile was written: no commit is reviewed yet, so every Prisma skill fails the safety gate.
  reviewed: [],
  category: "database",
  technology: "prisma",
  runtime: "node",
  engines: ["postgresql", "mysql", "sqlite", "sqlserver", "mongodb", "cockroachdb"],
  evidence: {
    orm: ["@prisma/client", "prisma"],
    engines: {
      pg: "postgresql",
      postgres: "postgresql",
      "@prisma/adapter-pg": "postgresql",
      "@prisma/adapter-neon": "postgresql",
      mysql2: "mysql",
      "@prisma/adapter-mariadb": "mysql",
      "@prisma/adapter-planetscale": "mysql",
      "better-sqlite3": "sqlite",
      "@prisma/adapter-better-sqlite3": "sqlite",
      "@prisma/adapter-libsql": "sqlite",
      "@prisma/adapter-d1": "sqlite",
      mssql: "sqlserver",
      "@prisma/adapter-mssql": "sqlserver",
      mongodb: "mongodb",
    },
  },
  exclusive: ["prisma-migrations", "prisma-upgrade", "postgresql"],
  highRisk: ["prisma-migrations", "prisma-upgrade"],
  guard: {
    phrases: ["migrate dev", "migrate deploy", "migrate reset", "migrate resolve", "db push", "db execute"],
    evaluations: MIGRATION,
  },
  skills: {
    "prisma-cli": {
      specific: ["prisma-cli", "prisma-migrations", "prisma-schema"],
      general: [],
      orm: ">=7 <8",
      engines: [],
      requirements: ["prisma-cli"],
      evaluations: MIGRATION,
      companions: [],
    },
    "prisma-client-api": {
      specific: ["prisma-client"],
      general: [],
      engines: [],
      requirements: ["prisma-generated-client"],
      evaluations: [],
      companions: [],
    },
    "prisma-orm-setup": {
      specific: ["prisma-database-setup"],
      general: ["sql"],
      engines: [],
      requirements: ["prisma-cli", "prisma-generated-client"],
      evaluations: MIGRATION,
      companions: [],
    },
    "prisma-postgres": {
      specific: ["prisma-postgres"],
      general: ["postgresql"],
      engines: ["postgresql"],
      requirements: ["prisma-cli"],
      evaluations: MIGRATION,
      companions: [],
    },
    "prisma-upgrade-v7": {
      specific: ["prisma-upgrade"],
      general: [],
      orm: ">=6 <8",
      engines: SQL_ENGINES,
      runtime: ">=20.19.0",
      requirements: ["prisma-cli", "prisma-generated-client"],
      evaluations: ["upgrade-breaking-changes", "upgrade-rollback-plan"],
      companions: [],
    },
  },
};

export const SOURCE_CONNECTORS: readonly SourceConnector[] = [PRISMA_CONNECTOR];
