export const version = "1.0.0";
export function register(api) {
  (globalThis.__scfPlugins ??= []).push({ name: "order-a", api });
}
