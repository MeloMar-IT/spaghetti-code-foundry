Check the TypeScript files of the change, and also any `tsconfig` file (including ones it extends), lint or generator configuration, and JavaScript file that the change converts or uses as a typed boundary.

- Untyped boundaries: is every value from JSON, the network, storage, the environment, user input or an untyped library checked at runtime before it is used as a typed value? A cast or a type annotation alone is not a check.
- No new broad `any`, unsafe `as` or `!`, `@ts-ignore`, `@ts-nocheck` or `@ts-expect-error`. The only exceptions: an existing boundary (small, with a comment that says why it is safe), and a type-level test where `@ts-expect-error` sits directly above the one expression under test with the expected error in a comment.
- `tsconfig`, lint rules and compiler flags were not loosened to make the change pass.
- Exported types: is a changed public type intended, and are callers and type tests updated?
- Promises: none left floating; errors of async work are handled; an `AbortSignal` that exists is passed on; timers and listeners are cleaned up.
- Unions are handled exhaustively; caught errors are narrowed before use.
- Generated files were not edited by hand.
- JavaScript files were not converted or given type syntax unless the task asked for it.
- The repository's type check, linter and tests were run.
