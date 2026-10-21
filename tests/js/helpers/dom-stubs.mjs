// Stand-ins for frontend modules a test does not want to load (the globe
// with MapLibre, the street view…): imports of those files resolve to
// dom-stub.mjs instead, keeping their query string, so every retry URL is a
// module of its own. Not a test file: tests import it.
//
//   stubModules(["sat-globe.js", "sat-street.js"]);
//   failModule("sat-globe.js", 1);   // the next import of it throws once

import { registerHooks } from "node:module";

const STUB = new URL("./dom-stub.mjs", import.meta.url).href;

export function stubModules(names) {
  const stubbed = new Set(names);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL && /^\.{1,2}\//.test(specifier)) {
        const url = new URL(specifier, context.parentURL);
        const name = url.pathname.split("/").pop();
        if (stubbed.has(name)) {
          const q = new URLSearchParams(url.search);
          q.set("stub", name);
          return { url: `${STUB}?${q}`, shortCircuit: true, format: "module" };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/** Make the next `times` imports of a stubbed module fail, as a download error would. */
export function failModule(name, times = 1) {
  (globalThis.__stubFail ??= {})[name] = times;
}

/** URLs of the stub modules loaded so far (with their ?v= and ?retry=). */
export const stubLoads = () => globalThis.__stubLoads ?? [];
