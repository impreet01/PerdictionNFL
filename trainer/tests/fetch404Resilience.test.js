// trainer/tests/fetch404Resilience.test.js
import assert from "assert/strict";
import { fetchCsvFlexible } from "../dataSources.js";

(async function testFetch404Resilience() {
  const realFetch = globalThis.fetch;
  function mock404() {
    globalThis.fetch = async () => {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Not Found"
      };
    };
  }

  try {
    mock404();
    const { rows, source, checksum } = await fetchCsvFlexible("https://example.com/missing.csv");
    assert(Array.isArray(rows), "rows should be an array");
    assert.equal(rows.length, 0, "rows should be empty on 404");
    assert.equal(source, "https://example.com/missing.csv");
    assert.equal(typeof checksum, "string");
    console.log("fetchCsvFlexible 404 resilience: passed");
  } finally {
    globalThis.fetch = realFetch;
  }
})();
