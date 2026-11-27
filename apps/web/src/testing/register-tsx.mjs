// Registers the .tsx compile hook for the test process:
//   node --import ./src/testing/register-tsx.mjs --experimental-strip-types --test ...
import { register } from "node:module";

register("./tsx-hooks.mjs", import.meta.url);
