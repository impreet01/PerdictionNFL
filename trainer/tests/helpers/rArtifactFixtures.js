import path from "node:path";
import { promises as fs } from "node:fs";

import parquet from "parquetjs-lite";

async function writeParquet(filePath, schemaDefinition, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const schema = new parquet.ParquetSchema(schemaDefinition);
  const writer = await parquet.ParquetWriter.openFile(schema, filePath);
  try {
    for (const row of rows) {
      await writer.appendRow(row);
    }
  } finally {
    await writer.close();
  }
}

export async function seedRArtifactsForTests(rootDir = path.resolve("artifacts", "r-data")) {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });

  const season = 2025;
  const week = 1;

  const pbpRows = [
    {
      season,
      week,
      season_type: "REG",
      posteam: "KAN",
      defteam: "DET",
      epa: 0.5,
      success: 1,
      xyac_epa: 0.2,
      wp: 0.65,
      cpoe: 5,
      play_id: "1234",
      game_id: "2025_01_DET_KAN",
      qtr: 1,
      down: 1,
      ydstogo: 10,
      yardline_100: 75
    },
    {
      season,
      week,
      season_type: "REG",
      posteam: "DET",
      defteam: "KAN",
      epa: -0.3,
      success: 0,
      xyac_epa: -0.1,
      wp: 0.45,
      cpoe: -2,
      play_id: "1235",
      game_id: "2025_01_DET_KAN",
      qtr: 2,
      down: 3,
      ydstogo: 6,
      yardline_100: 48
    },
    {
      season,
      week,
      season_type: "REG",
      posteam: "KAN",
      defteam: "DET",
      epa: 0.1,
      success: 1,
      xyac_epa: 0.05,
      wp: 0.66,
      cpoe: 1,
      play_id: "1236",
      game_id: "2025_01_DET_KAN",
      qtr: 4,
      down: 2,
      ydstogo: 4,
      yardline_100: 32
    }
  ];

  await writeParquet(
    path.join(rootDir, "pbp", `${season}.parquet`),
    {
      season: { type: "INT64" },
      week: { type: "INT64" },
      season_type: { type: "UTF8" },
      posteam: { type: "UTF8" },
      defteam: { type: "UTF8" },
      epa: { type: "DOUBLE" },
      success: { type: "BOOLEAN", optional: true },
      xyac_epa: { type: "DOUBLE", optional: true },
      wp: { type: "DOUBLE", optional: true },
      cpoe: { type: "DOUBLE", optional: true },
      play_id: { type: "UTF8", optional: true },
      game_id: { type: "UTF8", optional: true },
      qtr: { type: "INT64", optional: true },
      down: { type: "INT64", optional: true },
      ydstogo: { type: "INT64", optional: true },
      yardline_100: { type: "DOUBLE", optional: true }
    },
    pbpRows
  );

  const fourthRows = [
    {
      season,
      week,
      posteam: "DET",
      recommendation: "go",
      actual: "go",
      delta_wp: 0.07,
      yardline_100: 45,
      vegas_wp: 0.52
    },
    {
      season,
      week,
      posteam: "DET",
      recommendation: "punt",
      actual: "go",
      delta_wp: -0.05,
      yardline_100: 38,
      vegas_wp: 0.49
    },
    {
      season,
      week,
      posteam: "KAN",
      recommendation: "go",
      actual: "punt",
      delta_wp: -0.02,
      yardline_100: 41,
      vegas_wp: 0.61
    }
  ];

  await writeParquet(
    path.join(rootDir, "fourth_down", `${season}.parquet`),
    {
      season: { type: "INT64" },
      week: { type: "INT64" },
      posteam: { type: "UTF8" },
      recommendation: { type: "UTF8" },
      actual: { type: "UTF8" },
      delta_wp: { type: "DOUBLE" },
      yardline_100: { type: "DOUBLE", optional: true },
      vegas_wp: { type: "DOUBLE", optional: true }
    },
    fourthRows
  );

  const playerTemplates = [
    {
      recent_team: "KAN",
      position: "QB",
      rushing_attempts: 4,
      targets: 0,
      pass_attempts: 32,
      air_yards: 210,
      passing_yards: 280,
      sacks: 2
    },
    {
      recent_team: "KAN",
      position: "RB",
      rushing_attempts: 18,
      targets: 3,
      pass_attempts: 0,
      air_yards: 0,
      passing_yards: 0,
      sacks: 0
    },
    {
      recent_team: "DET",
      position: "WR",
      rushing_attempts: 1,
      targets: 8,
      pass_attempts: 0,
      air_yards: 110,
      passing_yards: 0,
      sacks: 0
    }
  ];

  const playerRows = Array.from({ length: 4000 }, (_, idx) => {
    const template = playerTemplates[idx % playerTemplates.length];
    return {
      season,
      week,
      season_type: "REG",
      recent_team: template.recent_team,
      position: template.position,
      rushing_attempts: template.rushing_attempts + (idx % 3),
      targets: template.targets + (idx % 4),
      pass_attempts: template.pass_attempts,
      air_yards: template.air_yards,
      passing_yards: template.passing_yards,
      sacks: template.sacks
    };
  });

  await writeParquet(
    path.join(rootDir, "player_weekly", `${season}.parquet`),
    {
      season: { type: "INT64" },
      week: { type: "INT64" },
      season_type: { type: "UTF8" },
      recent_team: { type: "UTF8" },
      position: { type: "UTF8" },
      rushing_attempts: { type: "DOUBLE", optional: true },
      targets: { type: "DOUBLE", optional: true },
      pass_attempts: { type: "DOUBLE", optional: true },
      air_yards: { type: "DOUBLE", optional: true },
      passing_yards: { type: "DOUBLE", optional: true },
      sacks: { type: "DOUBLE", optional: true }
    },
    playerRows
  );
  const manifest = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      seasons: [season],
      files: [
        { season, path: `${season}.parquet` }
      ]
    },
    null,
    2
  );

  await fs.writeFile(path.join(rootDir, "pbp", "manifest.json"), manifest);
  await fs.writeFile(path.join(rootDir, "fourth_down", "manifest.json"), manifest);
  await fs.writeFile(path.join(rootDir, "player_weekly", "manifest.json"), manifest);
}

export async function seedSeedSimArtifacts(rootDir = path.resolve("artifacts", "r-data")) {
  await fs.mkdir(path.join(rootDir, "seed_sim"), { recursive: true });
  const schema = new parquet.ParquetSchema({
    team: { type: "UTF8" },
    make_playoffs: { type: "DOUBLE", optional: true },
    win_division: { type: "DOUBLE", optional: true },
    top_seed: { type: "DOUBLE", optional: true },
    draft_pick: { type: "DOUBLE", optional: true },
    mean_wins: { type: "DOUBLE", optional: true }
  });
  const writer = await parquet.ParquetWriter.openFile(
    schema,
    path.join(rootDir, "seed_sim", "seed_sim_2025_W01.parquet")
  );
  try {
    await writer.appendRow({
      team: "KAN",
      make_playoffs: 0.89,
      win_division: 0.71,
      top_seed: 0.24,
      draft_pick: 28.2,
      mean_wins: 12.3
    });
    await writer.appendRow({
      team: "DET",
      make_playoffs: 0.66,
      win_division: 0.58,
      top_seed: 0.12,
      draft_pick: 22.7,
      mean_wins: 11.0
    });
  } finally {
    await writer.close();
  }

  const manifest = JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      season: 2025,
      week: 1,
      simulations: 2000,
      parquet: "seed_sim_2025_W01.parquet"
    },
    null,
    2
  );
  await fs.writeFile(path.join(rootDir, "seed_sim", "manifest_2025_W01.json"), manifest);
}

export default seedRArtifactsForTests;
