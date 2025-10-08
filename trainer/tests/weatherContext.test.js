import { buildFeatures } from "../featureBuild.js";
import { shapeWeatherContext } from "../contextPack.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makeGame(season, week, home, away) {
  return {
    season,
    week,
    season_type: "REG",
    home_team: home,
    away_team: away,
    game_id: `${season}-${week}-${home}-${away}`,
    game_date: `${season}-09-01`,
    roof: "outdoor"
  };
}

function makeTeamRow(season, week, team, opponent) {
  return {
    season,
    week,
    season_type: "REG",
    team,
    opponent,
    passing_yards: 220,
    rushing_yards: 110,
    passing_first_downs: 12,
    rushing_first_downs: 8,
    receiving_first_downs: 4,
    penalties: 45,
    penalty_yards: 45,
    turnovers: 1,
    passing_interceptions: 1,
    rushing_fumbles_lost: 0,
    receiving_fumbles_lost: 0,
    sack_fumbles_lost: 0,
    time_of_possession: "30:00"
  };
}

function makeTeamGameRow(season, week, team) {
  return {
    season,
    week,
    team,
    third_down_att: 12,
    third_down_conv: 6,
    red_zone_att: 4,
    red_zone_td: 2,
    pass_att: 32,
    rush_att: 26,
    sacks_taken: 2,
    off_dropbacks: 34,
    off_sacks_taken: 2
  };
}

async function main() {
  const season = 2023;
  const week = 1;
  const schedules = [makeGame(season, week, "A", "B")];
  const teamWeekly = [
    makeTeamRow(season, week, "A", "B"),
    makeTeamRow(season, week, "B", "A")
  ];
  const teamGame = [
    makeTeamGameRow(season, week, "A"),
    makeTeamGameRow(season, week, "B")
  ];

  const weatherRows = [
    {
      season,
      week,
      home_team: "A",
      away_team: "B",
      temperature_f: 35,
      precipitation_chance: 80,
      wind_mph: 20,
      impact_score: 0.6,
      game_key: `${season}-W${String(week).padStart(2, "0")}-A-B`,
      fetched_at: "2023-09-01T12:00:00Z"
    }
  ];

  const features = buildFeatures({
    teamWeekly,
    teamGame,
    schedules,
    season,
    prevTeamWeekly: [],
    pbp: [],
    playerWeekly: [],
    weather: weatherRows
  });

  const homeRow = features.find((row) => row.team === "A" && row.week === week && row.season === season && row.home === 1);
  const awayRow = features.find((row) => row.team === "B" && row.week === week && row.season === season && row.home === 0);

  assert(homeRow, "Home row missing");
  assert(awayRow, "Away row missing");

  const expectedTemp = 35;
  const expectedWind = 20;
  const expectedPrecip = 80;
  const expectedImpact = 0.6;

  assert(Math.abs(homeRow.weather_temp_f - expectedTemp) < 1e-6, "Home weather temperature mismatch");
  assert(Math.abs(homeRow.weather_wind_mph - expectedWind) < 1e-6, "Home weather wind mismatch");
  assert(Math.abs(homeRow.weather_precip_pct - expectedPrecip) < 1e-6, "Home weather precip mismatch");
  assert(Math.abs(homeRow.weather_impact_score - expectedImpact) < 1e-6, "Home weather impact mismatch");
  assert(homeRow.weather_extreme_flag === 1, "Home weather extreme flag not set");

  assert(Math.abs(awayRow.weather_temp_f - expectedTemp) < 1e-6, "Away weather temperature mismatch");
  assert(Math.abs(awayRow.weather_wind_mph - expectedWind) < 1e-6, "Away weather wind mismatch");
  assert(Math.abs(awayRow.weather_precip_pct - expectedPrecip) < 1e-6, "Away weather precip mismatch");
  assert(Math.abs(awayRow.weather_impact_score - expectedImpact) < 1e-6, "Away weather impact mismatch");
  assert(awayRow.weather_extreme_flag === 1, "Away weather extreme flag not set");

  const shaped = shapeWeatherContext({
    summary: "Rain",
    details: "Heavy rain in Chicago",
    notes: "Strong winds expected.",
    temperature_f: 38,
    precipitation_chance: 90,
    wind_mph: 22,
    impact_score: 0.7,
    kickoff_display: "1:00 PM EST",
    location: "Chicago, IL",
    forecast_provider: "Forecast.io",
    forecast_links: [{ label: "Weather.com", url: "https://weather.com" }],
    icon: "https://example.com/icon.png",
    fetched_at: "2023-09-01T12:00:00Z",
    is_dome: false
  });

  assert(shaped.summary === "Rain", "shapeWeatherContext summary mismatch");
  assert(shaped.forecast_links.length === 1 && shaped.forecast_links[0].url === "https://weather.com", "forecast link missing");
  assert(shaped.weather_extreme_flag === undefined, "shapeWeatherContext should not expose derived flags");

  console.log("Weather context + feature tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
