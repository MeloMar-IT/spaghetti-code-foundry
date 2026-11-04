// Collects every usage event it gets into globalThis.__scfUsage, tagged with the instance number of the load.
export const version = "1.0.0";
let loads = 0;
export function register(api) {
  const instance = ++loads;
  api.onUsage((event) => {
    (globalThis.__scfUsage ??= []).push({ instance, event });
  });
}
