export function register(api) {
  if (!api.version.startsWith("9.")) throw new Error("needs plugin API 9.x");
}
