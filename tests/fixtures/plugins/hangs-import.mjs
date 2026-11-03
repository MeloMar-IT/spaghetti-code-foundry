// Never settles during import: a top-level await that nothing resolves.
await new Promise(() => {});

export function register() {}
