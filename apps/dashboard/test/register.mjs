// lib/ uses bundler-style extensionless imports; teach plain node to resolve them.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[cm]?js$/.test(specifier.split("?")[0]))
      return next(`${specifier}.js`, context);
    return next(specifier, context);
  },
});
