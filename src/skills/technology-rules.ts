// The Java, Spring and build tool versions the Foundry treats as supported. Data only: the owner changes it by pull request.
// Policy: a release line is listed while the owner accepts it for new work on TECHNOLOGY_SUPPORT_REVIEWED.
//  - Java: the LTS lines that the listed Spring lines run on.
//  - Spring Boot and Spring Framework: the lines that get free (open-source) updates. A line that only has paid support is not listed.
//  - Gradle: the whole major line "9" is listed, so a range is not marked stale because of minor releases; "8.14" is the last 8 line.
//  - Maven: "4.0" is listed once it is a final release (not a release candidate); a range that only fits an older 3.x line is stale.
// Sources to check at every review: https://spring.io/projects/spring-boot#support, https://spring.io/projects/spring-framework#support,
// https://maven.apache.org/docs/history.html, https://docs.gradle.org/current/userguide/feature_lifecycle.html, https://adoptium.net/support/.
// Lines are "N" or "N.M" and are compared with the ranges a skill declares (see rangeAdmitsLine).

export const TECHNOLOGY_NAMES = ["java", "spring-boot", "spring-framework", "maven", "gradle"] as const;
export type TechnologyName = (typeof TECHNOLOGY_NAMES)[number];

export const TECHNOLOGY_SUPPORT_REVIEWED = "2026-10-14";

export const SUPPORTED_LINES: Readonly<Record<TechnologyName, readonly string[]>> = {
  java: ["17", "21", "25"],
  "spring-boot": ["4.0", "4.1"],
  "spring-framework": ["7.0"],
  maven: ["3.9", "4.0"],
  gradle: ["8.14", "9"],
};

/** Other spellings of the five names. */
export const TECHNOLOGY_ALIASES: Readonly<Record<string, TechnologyName>> = {
  jdk: "java", openjdk: "java", springboot: "spring-boot", spring: "spring-framework", "spring-core": "spring-framework",
  mvn: "maven", "apache-maven": "maven", "gradle-wrapper": "gradle", gradlew: "gradle",
};

/** Up to four numeric parts and an optional qualifier (3.2.1, 17, 2.3.4.RELEASE, 8.5-rc-1). Only characters that finding values allow. */
export const PLAIN_VERSION_RE = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:[.-][0-9A-Za-z][0-9A-Za-z.-]{0,30})?$/;

/** The value of a technology finding whose version is declared but not readable. It is not a version, so it never counts as evidence. */
export const UNREADABLE_VERSION = "unreadable";

/** Dependency names whose values must be plain versions in pom.xml and Gradle files. */
export const SPRING_NAME_RE = /^org\.springframework(?:\.boot)?:/;
