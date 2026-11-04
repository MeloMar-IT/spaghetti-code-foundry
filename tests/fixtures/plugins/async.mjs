export async function register(api) {
  await new Promise((r) => setTimeout(r, 5));
  (globalThis.__scfPlugins ??= []).push({ name: "async", api });
}
