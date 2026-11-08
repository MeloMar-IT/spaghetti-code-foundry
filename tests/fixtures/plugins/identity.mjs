// An identity provider (#833) that knows nobody: it only registers, to test the plugin point and the start rules.
export const version = "1.0.0";
export function register(api) {
  api.identityProvider({ resolve: () => null });
}
