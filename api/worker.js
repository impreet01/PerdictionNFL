// api/worker.js
// Cloudflare Worker that serves predictions JSON for a given season/week.
// After deploying, set REPO_RAW to your repo's raw URL.

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/predict_week") {
      return new Response(JSON.stringify({ error: "use /predict_week?season=YYYY&week=WW" }), { status: 404 });
    }
    const season = url.searchParams.get("season");
    const week = url.searchParams.get("week");
    if (!season || !week) {
      return new Response(JSON.stringify({ error: "season & week required" }), { status: 400 });
    }

    const REPO_RAW = "https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main";
    const predUrl = `${REPO_RAW}/artifacts/predictions_${season}_W${String(week).padStart(2, "0")}.json`;
    const res = await fetch(predUrl);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "predictions not found; run the training workflow first" }), { status: 404 });
    }
    const json = await res.json();
    return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
  }
};