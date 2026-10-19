/**
 * The manifest bundle needs only BRAND_CONFIG_JSON_SCHEMA from config.ts, but
 * config.ts also imports parseRules from features/rules/schema.ts, whose
 * top-level zod schemas esbuild keeps as side effects. This plugin marks
 * that one module side-effect free in the manifest build, so esbuild drops
 * it, and zod with it, when nothing the manifest uses needs it (RK9-579).
 * The worker build does not use it.
 */
export const manifestWithoutZod = {
  name: "rk9-ads-manifest-without-zod",
  setup(build) {
    build.onResolve({ filter: /\/features\/rules\/schema\.js$/ }, async (args) => {
      if (args.pluginData?.manifestWithoutZod) return undefined;
      const resolved = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: { manifestWithoutZod: true },
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, namespace: resolved.namespace, sideEffects: false };
    });
  },
};
