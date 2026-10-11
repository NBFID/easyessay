// Loads gaze.js and lookups.js in Node for the tests: the modules only need a `window` to hang
// their classes on, a viewport size and a clock.
global.window = globalThis;
global.innerWidth = 1920;
global.innerHeight = 1080;
global.addEventListener = () => {};
global.removeEventListener = () => {};
if (!global.performance) global.performance = { now: () => Date.now() };
require('../gaze.js');
require('../lookups.js');

// A seeded normal generator, so a run is repeatable
function rng(seed = 1) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  return { u, g };
}
module.exports = { rng };
