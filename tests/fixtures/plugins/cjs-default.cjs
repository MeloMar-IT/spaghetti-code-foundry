module.exports = {
  register(api) {
    (globalThis.__scfPlugins ??= []).push({ name: "cjs", api });
  },
};
