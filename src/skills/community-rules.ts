/** Repositories that are always `trust: community`, as `repositoryKey` values (lower case). */
export const COMMUNITY_REPOSITORIES: readonly string[] = ["github.com/jiangxianze/spring-agent-skills"];

/** The built-in skills `scf skills compare` compares an import with. */
export const COMPARE_BUILTINS = ["java", "spring-boot"] as const;

/** Other spellings of an upstream term, applied before the rules. */
export const COMMUNITY_TERM_ALIASES: Readonly<Record<string, string>> = {
  springboot: "spring-boot",
  "spring-boot-starter": "spring-boot",
  jdk: "java",
  openjdk: "java",
};

/** A rule matches when a skill has every term. The capability is a built-in one. Used for the comparison only; the package is not changed. */
export const COMMUNITY_CAPABILITY_RULES: readonly { terms: readonly string[]; capability: string }[] = [
  { terms: ["java"], capability: "java-language" },
  { terms: ["java-language"], capability: "java-language" },
  { terms: ["spring-boot", "configuration"], capability: "spring-boot-configuration" },
  { terms: ["spring-boot", "config"], capability: "spring-boot-configuration" },
  { terms: ["spring-boot-configuration"], capability: "spring-boot-configuration" },
  { terms: ["spring-boot", "web"], capability: "spring-boot-web" },
  { terms: ["spring-boot", "rest"], capability: "spring-boot-web" },
  { terms: ["spring-boot-web"], capability: "spring-boot-web" },
  { terms: ["spring-boot", "transactions"], capability: "spring-boot-transactions" },
  { terms: ["spring-boot", "transaction"], capability: "spring-boot-transactions" },
  { terms: ["spring-boot-transactions"], capability: "spring-boot-transactions" },
  { terms: ["spring-boot", "observability"], capability: "spring-boot-observability" },
  { terms: ["spring-boot", "actuator"], capability: "spring-boot-observability" },
  { terms: ["spring-boot-observability"], capability: "spring-boot-observability" },
  { terms: ["spring-boot", "testing"], capability: "spring-boot-test-slices" },
  { terms: ["spring-boot", "test-slices"], capability: "spring-boot-test-slices" },
  { terms: ["spring-boot-test-slices"], capability: "spring-boot-test-slices" },
];

/** Upstream keys (`provenance.upstream`) whose lists are read as extra terms. */
export const COMMUNITY_TERM_KEYS = [
  "frontmatter.tags", "frontmatter.keywords", "metadata.tags", "metadata.keywords", "manifest.tags", "manifest.keywords",
] as const;
/** The same lists when upstream gave plain text, which the normalizer keeps in `package.metadata`. */
export const COMMUNITY_METADATA_KEYS = ["tags", "keywords"] as const;
