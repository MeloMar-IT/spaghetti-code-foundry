---
name: java
description: "Java: versions, compatibility, nulls, exceptions, resources, concurrency, JUnit. Use for Java sources or Java builds; not Kotlin/Scala-only or non-Java work."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "1200"
  budget-reviewer-tokens: "400"
---

# Java

## When this applies

- Use it when the change edits or adds `.java` files, or a Maven/Gradle build that compiles Java.
- Do not use it for Kotlin-, Scala- or Groovy-only modules, or for work with no Java.
- In a mixed module, apply it to the Java sources and to the build and test settings that affect Java; not to Kotlin, Scala or Groovy source.
- Framework rules (Spring Boot and others) and database rules live in their own skills; this skill does not cover them.

## Follow the repository first

- Read the build file and two or three nearby classes before writing.
- Match the package layout, naming, formatting, logging and the null and error style already used.
- Use the libraries and plugins the build already has. Do not add a dependency, plugin or annotation processor unless the task asks for it.
- Use the project's wrapper (`./mvnw`, `./gradlew`) when it exists.

## Source and runtime version

- Tell apart the JDK that compiles, the source level, the bytecode target and the minimum runtime. `source`/`target` alone do not limit JDK APIs; `--release` (`maven.compiler.release`, Gradle `options.release`) does.
- Find the baseline in the build (`release`, Gradle `toolchain`, `sourceCompatibility`), `.java-version` and CI. If no `release` is set, check the minimum runtime the project states.
- Use only language features and JDK APIs of that baseline (records, `var`, switch expressions, text blocks, virtual threads and so on only when it allows).
- Do not raise the level or turn on preview features.

## API compatibility

- Treat public and protected types of a library or shared module as a contract: source, binary and behaviour.
- Do not remove, rename or change signatures, checked exceptions, or `equals`/`hashCode`/serialised form.
- Before an additive change, check that it cannot break callers: a new overload can make a call ambiguous, and a default method can clash with an existing one. Deprecate before removing.
- Keep new members as private as possible.

## Null handling

- An existing contract or project convention wins over the defaults below.
- Follow the nullness annotations or the `Optional` style the project already has; do not introduce a new annotation library.
- In new APIs, return an empty collection or array, not `null`.
- In new APIs, use `Optional` for return values only, not for fields or parameters.
- Check arguments at public boundaries (`Objects.requireNonNull`) where the project does.

## Exceptions

- Throw the most specific type and use the project's exception types.
- Never swallow an exception; keep the cause when wrapping.
- Do not catch `Throwable` or `Error`, or `Exception` without a reason.
- Do not use exceptions for normal flow.
- On `InterruptedException`, restore the interrupt flag or rethrow.
- Do not log and rethrow the same exception.

## Resources

- Use try-with-resources for every `AutoCloseable` your code opens. Do not close one that the caller or a framework owns.
- Close `Files.lines`/`list`/`walk` streams.
- Do not rely on finalizers.
- Name a charset explicitly (`StandardCharsets.UTF_8`).

## Concurrency

- Prefer immutable objects and confinement.
- Use `java.util.concurrent` (executors, concurrent collections, atomics) over hand-made `wait`/`notify`.
- Give shared mutable state one thread-safety strategy: confinement, immutability, atomics or `volatile`, a concurrent collection, or a lock. Where a lock protects an invariant, use the same lock for every access.
- Do not block inside `synchronized` or hold a lock while calling foreign code.
- Do not start unmanaged threads; use the project's executor and shut down the ones you create.
- No double-checked locking without `volatile`.

## Collections and streams

- Declare interface types (`List`, `Map`).
- Do not expose internal mutable collections; return a copy or an unmodifiable view.
- `List.of`/`Map.of` are immutable and refuse `null`.
- Do not modify a collection while iterating.
- Keep `equals`/`hashCode` consistent for keys.
- Use streams when they read clearer, with no side effects in `map`/`filter`.

## Tests (JUnit)

- Use the JUnit version and assertion library already in the build; do not mix JUnit 4 and 5 in one class.
- One behaviour per test, with a name that says it.
- Test failures with `assertThrows` only if the installed JUnit or assertion library has it (JUnit 4.13+, 5); otherwise use the repository's own way. Use parameterised tests for tables where available.
- No `Thread.sleep`; no reliance on test order, the wall clock or the network.
- Run the module's tests with the project's build tool before finishing.
