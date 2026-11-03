export const version = "2.0.0";
export function register(api) {
  (globalThis.__scfPlugins ??= []).push({ name: "order-b", api });
}
