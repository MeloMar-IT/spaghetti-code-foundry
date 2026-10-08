/** Rule tables for interface and database candidates (see integration-candidates.ts). Data only. */

export const INTEGRATION_CAPABILITIES = ["rest-openapi", "kafka", "ibm-mq", "cassandra", "oracle"] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];
export const INTEGRATION_CATEGORY: Record<IntegrationCapability, "interface" | "database"> = {
  "rest-openapi": "interface", kafka: "interface", "ibm-mq": "interface", cassandra: "database", oracle: "database",
};

export type Ecosystem = "npm" | "python" | "go" | "jvm" | "rust" | "ruby";

export const INTEGRATION_SCORING = { strong: 40, weak: 20, docsFactor: 0.5, docsOnlyCap: 30, high: 70, medium: 40, evidence: 10 } as const;

/** A path segment (any case) that marks documentation or example material. */
export const DOC_SEGMENTS: ReadonlySet<string> = new Set(["docs", "doc", "documentation", "examples", "example", "samples", "sample", "tutorials"]);

export interface PackageRule {
  capability: IntegrationCapability;
  ecosystem: Ecosystem;
  on: "dependency" | "import" | "both";
  /** Lower-case; exact, or a prefix when it ends in `*`. */
  pattern: string;
  weak?: true;
}
export interface FileRule { capability: IntegrationCapability; schema: string; weight: number }

/** Compact form: "dep:x" only dependencies, "imp:x" only imports, otherwise both; a trailing "?" marks a weak signal. */
const T: Record<IntegrationCapability, Partial<Record<Ecosystem, string>>> = {
  kafka: {
    npm: "kafkajs node-rdkafka @confluentinc/kafka-javascript",
    python: "confluent-kafka aiokafka dep:kafka-python imp:kafka",
    go: "github.com/segmentio/kafka-go github.com/ibm/sarama github.com/shopify/sarama github.com/confluentinc/confluent-kafka-go github.com/twmb/franz-go",
    jvm: "dep:org.apache.kafka:* dep:org.springframework.kafka:* dep:io.confluent:kafka-* dep:io.projectreactor.kafka:* imp:org.apache.kafka imp:org.springframework.kafka imp:io.confluent.kafka imp:reactor.kafka",
    rust: "rdkafka",
    ruby: "dep:ruby-kafka dep:rdkafka dep:karafka",
  },
  "ibm-mq": {
    npm: "ibmmq",
    python: "pymqi",
    go: "github.com/ibm-messaging/mq-golang github.com/ibm-messaging/mq-golang-jms20",
    jvm: "dep:com.ibm.mq:* imp:com.ibm.mq imp:com.ibm.msg",
  },
  cassandra: {
    npm: "cassandra-driver",
    python: "dep:cassandra-driver imp:cassandra",
    go: "github.com/gocql/gocql github.com/apache/cassandra-gocql-driver",
    jvm: "dep:com.datastax.oss:java-driver-* dep:com.datastax.cassandra:* dep:org.apache.cassandra:* dep:org.springframework.data:spring-data-cassandra dep:org.springframework.boot:spring-boot-starter-data-cassandra* imp:com.datastax.oss imp:com.datastax.driver imp:org.springframework.data.cassandra",
    rust: "cdrs-tokio cassandra-cpp",
    ruby: "dep:cassandra-driver",
  },
  oracle: {
    npm: "oracledb",
    python: "oracledb cx-oracle",
    go: "github.com/godror/godror github.com/sijms/go-ora github.com/mattn/go-oci8",
    jvm: "dep:com.oracle.database.jdbc:* dep:com.oracle.database.r2dbc:* dep:com.oracle.ojdbc:* imp:oracle.jdbc imp:oracle.ucp",
    rust: "oracle sibyl",
    ruby: "dep:ruby-oci8 dep:activerecord-oracle_enhanced-adapter",
  },
  "rest-openapi": {
    npm: "swagger-ui-express swagger-jsdoc @nestjs/swagger @fastify/swagger express-openapi-validator openapi-types openapi-typescript @openapitools/openapi-generator-cli express? fastify? koa? @nestjs/core? @hapi/hapi?",
    python: "fastapi connexion flask-restx flask-restful drf-spectacular drf-yasg dep:djangorestframework imp:rest-framework flask?",
    go: "github.com/swaggo/swag github.com/getkin/kin-openapi github.com/oapi-codegen/oapi-codegen github.com/deepmap/oapi-codegen github.com/go-openapi/* github.com/gin-gonic/gin? github.com/go-chi/chi? github.com/labstack/echo? github.com/gorilla/mux?",
    jvm: "dep:org.springdoc:* dep:io.swagger.core.v3:* dep:io.springfox:* dep:org.openapitools:* dep:jakarta.ws.rs:* dep:javax.ws.rs:* dep:org.glassfish.jersey.* dep:org.springframework.boot:spring-boot-starter-web? dep:org.springframework.boot:spring-boot-starter-webflux? imp:io.swagger.v3 imp:jakarta.ws.rs imp:org.springframework.web?",
    rust: "utoipa axum? actix-web? rocket?",
  },
};

export const PACKAGE_RULES: readonly PackageRule[] = Object.entries(T).flatMap(([capability, byEco]) =>
  Object.entries(byEco).flatMap(([ecosystem, list]) =>
    list!.split(" ").map((tok): PackageRule => {
      const on = tok.startsWith("dep:") ? "dependency" : tok.startsWith("imp:") ? "import" : "both";
      let pattern = on === "both" ? tok : tok.slice(4);
      const weak = pattern.endsWith("?");
      if (weak) pattern = pattern.slice(0, -1);
      return { capability: capability as IntegrationCapability, ecosystem: ecosystem as Ecosystem, on, pattern, ...(weak ? { weak: true as const } : {}) };
    }),
  ),
);

// "sql", "avro", "protobuf", "graphql", "json-schema", "prisma" and "xsd" deliberately have no rule: they are generic.
export const FILE_RULES: readonly FileRule[] = [
  { capability: "rest-openapi", schema: "openapi", weight: 50 },
  { capability: "ibm-mq", schema: "mqsc", weight: 30 },
  { capability: "oracle", schema: "plsql", weight: 30 },
  { capability: "oracle", schema: "oracle-net", weight: 30 },
  { capability: "kafka", schema: "kafka-config", weight: 30 },
  { capability: "cassandra", schema: "cql", weight: 20 }, // Cypher files also use .cql
];
