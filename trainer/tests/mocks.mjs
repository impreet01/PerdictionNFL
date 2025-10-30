import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fx = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', ...p), 'utf-8'));

const games = fx('games_2023_w1.json');
const teams = fx('teams.json');
const weather = fx('weather_2023_w1.json');
const contextPack = fx('contextPack.json');

export async function mockDataLayers() {
  await jest.unstable_mockModule('../dataSources.js', () => ({
    loadDataSources: async () => ({
      async loadGames(season, week) {
        return games.filter(g => (!season || g.season === season) && (!week || g.week === week));
      },
      async loadTeams() { return teams; },
      async loadWeather(season, week) {
        return weather.filter(w => (!season || w.season === season) && (!week || w.week === week));
      },
      async loadMarket() {
        return games.map(g => ({ season:g.season, week:g.week, homeTeam:g.homeTeam, awayTeam:g.awayTeam, spread:g.spread, total:g.closeTotal }));
      }
    })
  }));

  await jest.unstable_mockModule('../contextPack.js', () => ({
    loadContextPacks: async () => contextPack
  }));

  await jest.unstable_mockModule('../schemaValidator.js', () => ({
    assertSchema: () => {}
  }));
}
