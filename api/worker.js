// api/worker.js
// Auto-select latest predictions JSON when ?week is missing.
// If ?season is also missing, chooses latest season found in /artifacts.
//
// Requirements: public GitHub repo (so GitHub API can list folder contents without auth).
// If your repo is private, add a GitHub token and send it as an Authorization header.

const REPO_USER = "impreet01";
const REPO_NAME = "PerdictionNFL";
const BRANCH = "main";

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_USER}/${REPO_NAME}/${BRANCH}`;
const GH_API_LIST = `https://api.github.com/repos/${REPO_USER}/${REPO_NAME}/contents/artifacts?ref=${BRANCH}`;

export default {
  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname !== "/predict_week") {
        return json({ error: "use /predict_week?season=YYYY[&week=WW]" }, 404);
      }

      let season = url.searchParams.get("season");
      let week = url.searchParams.get("week");

      if (!week || !season) {
        // List artifacts folder and find the newest predictions file
        const listing = await listArtifacts();
        const parsed = parsePredFiles(listing); // [{season, week, name}]
        if (!parsed.length) {
          return json({ error: "no predictions found in artifacts/" }, 404);
        }

        if (!season) {
          // pick the latest season present
          season = String(
            parsed.reduce((max, r) => (r.season > max ? r.season : max), parsed[0].season)
          );
        }
        const forSeason = parsed.filter((r) => String(r.season) === String(season));
        if (!forSeason.length) {
          return json({ error: `no predictions for season ${season}` }, 404);
        }
        if (!week) {
          // pick the highest week in that season
          week = String(
            forSeason.reduce((max, r) => (r.week > max ? r.week : max), forSeason[0].week)
          );
        }
      }

      const file = `predictions_${season}_W${String(week).padStart(2, "0")}.json`;
      const urlRaw = `${RAW_BASE}/artifacts/${file}`;

      const resp = await fetch(urlRaw, { cf: { cacheEverything: true, cacheTtl: 900 } });
      if (!resp.ok) {
        return json({ error: `predictions not found for ${season} W${week}` }, 404);
      }
      const body = await resp.text(); // keep as text to pass through exactly
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=900"
        }
      });
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }
};

// ----- helpers -----
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function listArtifacts() {
  // For public repos this works without auth. If your repo is private, add:
  // headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
  const r = await fetch(GH_API_LIST, { headers: { "User-Agent": "cf-worker" } });
  if (!r.ok) throw new Error(`GitHub API list failed: ${r.status}`);
  return r.json();
}

function parsePredFiles(listing) {
  // Expect objects with "name": predictions_<season>_W<week>.json
  const out = [];
  for (const item of listing) {
    if (!item || item.type !== "file") continue;
    const m = /^predictions_(\d{4})_W(\d{2})\.json$/i.exec(item.name);
    if (!m) continue;
    out.push({ season: Number(m[1]), week: Number(m[2]), name: item.name });
  }
  // sort newest first (season desc, week desc)
  out.sort((a, b) => (b.season - a.season) || (b.week - a.week));
  return out;
}
