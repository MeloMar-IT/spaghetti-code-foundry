---
name: typescript
description: TypeScript engineering - strict types, narrowing, safe async code and module boundaries, using the repository's own compiler, linter and tests.
---

# TypeScript

## Scope

- These rules apply to TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`, `.d.ts`) and to `tsconfig` files.
- When the task touches only JavaScript files, leave them JavaScript: do not convert them, add type syntax or add a TypeScript toolchain unless the task asks for it. (In a `checkJs` project, keep the JavaScript files valid for the existing checks.)
- Do not assume Node.js, a browser or a UI framework. Read `tsconfig.json` (`lib`, `types`, `module`, `moduleResolution`, `jsx`) and the imports around your change to learn the runtime and the module system.

## Use the repository's tools

- Use the package manager of the lockfile that exists. Do not add a second lockfile.
- Run the repository's own type check, linter, formatter and tests, with its scripts and settings. Do not format files you did not change.
- Do not loosen `tsconfig`, lint rules or `skipLibCheck` to make a change pass.

## Types

- No broad `any`: not as a parameter, return type, generic default or cast. Use `unknown` and narrow it.
- No unsafe assertions: no `as` to silence an error, no `as unknown as T`, no non-null `!` on a value that can be missing. Narrow with `typeof`, `in`, `instanceof`, a discriminant or a type guard.
- Never ignore a compiler error: no `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error` to get past the type check.
- Exception: an existing boundary that already needs one (an untyped library, generated code, a legacy module). Keep it to one line or one small function, do not widen it, and write a comment that says why it is needed and what makes it safe.
- Handle every member of a union. End a `switch` over a discriminant with a `never` check.
- Respect the strict flags in use (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`): an indexed value or optional property can be `undefined`.

## Public types and generics

- Exported functions, classes and constants keep explicit parameter and return types. A change to an exported type is an API change: say so, and check the callers.
- Do not leak internal types through exports. Prefer `readonly` and narrow unions over `string` or `object`.
- A type parameter must relate at least two positions (inputs, or input and output); otherwise use a concrete type. Constrain it with `extends` instead of casting inside.

## Errors

- A caught value is `unknown`: narrow it before reading `message` or `code`.
- Throw `Error` objects, never strings. Keep the `cause` when you wrap an error. Do not swallow an error without a reason in a comment.

## Promises and cancellation

- Every promise is awaited, returned or handled. No floating promises, no `async` callback where the caller ignores the result (`forEach`, event handlers) without its own error handling.
- Use `Promise.all` for independent work and say what happens when one part fails.
- Pass an existing `AbortSignal` or cancellation token through to the calls you make. Clear timers and listeners on every path, also on failure.

## Module boundaries

- Follow the import style in use: ESM or CommonJS, file extensions in paths, path aliases, barrel files. Use `import type` for types where the project does.
- Do not import another package's internal files, and do not add a circular import.
- Data from outside the type system (JSON, network, storage, environment, user input, `postMessage`) is `unknown` until a runtime check proves its shape. Use the validation the repository already has.

## Generated types

- Never edit generated files (API clients, schema types, `.d.ts` output). Change the source and run the repository's generator.

## Tests

- Add or update tests in the repository's test framework for the behaviour you change.
- Where the repository has type-level tests (`expectTypeOf`, `tsd`, `*.test-d.ts`), add one for a public type you change.
- In a type-level test, `@ts-expect-error` is allowed only as an intentional negative assertion: put it directly above the one expression whose error is tested, and add a comment with the error you expect. Any other use follows the existing-boundary exception above.
- Finish only when the type check, the linter and the tests pass. Report what you ran.
