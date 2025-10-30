process.env.CI = process.env.CI || 'true';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

// Jest passes CLI flags such as --runInBand that confuse the legacy trainer's
// parseArgs invocation; trim them globally before any modules evaluate.
const argvCopy = process.argv.slice();
const runInBandIdx = argvCopy.indexOf('--runInBand');
if (runInBandIdx !== -1) {
  argvCopy.splice(runInBandIdx, argvCopy.length - runInBandIdx, '--');
  process.argv.splice(0, process.argv.length, ...argvCopy);
}

// deterministic RNG
let _seed = 123456789;
export function setSeed(n = 42) { _seed = n >>> 0; }
function lcg() { _seed = (1664525 * _seed + 1013904223) >>> 0; return (_seed & 0xffffffff) / 0x100000000; }
const _origRandom = Math.random;
Math.random = () => lcg();
globalThis.__TEST_RANDOM__ = { setSeed, _origRandom };

// block network in tests
const block = (name) => () => { throw new Error(`Network call blocked in tests: ${name}`); };
globalThis.fetch = block('fetch');
try { const http = await import('node:http'); http.request = block('http.request'); } catch {}
try { const https = await import('node:https'); https.request = block('https.request'); } catch {}
