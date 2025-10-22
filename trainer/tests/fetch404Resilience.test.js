import assert from "assert/strict";
import { fetchCsvFlexible } from "../dataSources.js";

const realFetch = globalThis.fetch;

async function main() {
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Not Found"
    });
    const out = await fetchCsvFlexible("https://example.com/missing.csv");
    assert(Array.isArray(out.rows));
    assert.equal(out.rows.length, 0);
    assert.equal(out.checksum, "missing404");
    console.log("fetch404Resilience: PASS");
  } catch (err) {
    console.error("fetch404Resilience: FAIL");
    console.error(err);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = realFetch;
  }
}

await main();
