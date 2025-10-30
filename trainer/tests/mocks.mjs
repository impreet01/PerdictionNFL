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
  const emptyArrayAsync = async () => [];

  await jest.unstable_mockModule('../dataSources.js', () => ({
    loadDataSources: async () => ({
      async loadGames(season, week) {
        return games.filter(
          (g) => (!season || g.season === season) && (!week || g.week === week)
        );
      },
      async loadTeams() {
        return teams;
      },
      async loadWeather(season, week) {
        return weather.filter(
          (w) => (!season || w.season === season) && (!week || w.week === week)
        );
      },
      async loadMarket() {
        return games.map((g) => ({
          season: g.season,
          week: g.week,
          homeTeam: g.homeTeam,
          awayTeam: g.awayTeam,
          spread: g.spread,
          total: g.closeTotal
        }));
      }
    }),
    async loadSchedules() {
      return games.map(({ season, week, homeTeam, awayTeam }) => ({
        season,
        week,
        homeTeam,
        awayTeam
      }));
    },
    async listDatasetSeasons() {
      const seasons = new Set(games.map((g) => g.season));
      return Array.from(seasons).sort((a, b) => a - b);
    },
    loadTeamWeekly: emptyArrayAsync,
    loadTeamGameAdvanced: emptyArrayAsync,
    loadPBP: emptyArrayAsync,
    loadPlayerWeekly: emptyArrayAsync,
    loadRostersWeekly: emptyArrayAsync,
    loadDepthCharts: emptyArrayAsync,
    loadInjuries: emptyArrayAsync,
    loadSnapCounts: emptyArrayAsync,
    loadPFRAdvTeam: emptyArrayAsync,
    loadPFRAdvTeamWeekly: emptyArrayAsync,
    loadESPNQBR: emptyArrayAsync,
    loadOfficials: emptyArrayAsync,
    loadWeather: emptyArrayAsync,
    loadNextGenStats: emptyArrayAsync,
    loadParticipation: emptyArrayAsync,
    loadMarkets: emptyArrayAsync,
    loadFTNCharts: emptyArrayAsync
  }));

  await jest.unstable_mockModule('../contextPack.js', () => ({
    loadContextPacks: async () => contextPack,
    async buildContextForWeek() {
      return Array.isArray(contextPack) ? contextPack : [contextPack];
    }
  }));

  await jest.unstable_mockModule('../schemaValidator.js', () => ({
    assertSchema: () => {},
    validateArtifact: () => {}
  }));

  await jest.unstable_mockModule('../train_multiOLD.js', () => ({
    formatBatchWindowLog: (...args) => args.join(' '),
    resolveHistoricalChunkSelection: () => ({ seasons: [2023], weeks: [1] }),
    async runTraining({ season = 2023, week = 1 } = {}) {
      return {
        season,
        week,
        predictions: {
          preds: [
            {
              homeTeam: games[0].homeTeam,
              awayTeam: games[0].awayTeam,
              probaHomeWin: 0.55
            }
          ]
        },
        schedules: games.map(({ season: s, week: w, homeTeam, awayTeam }) => ({
          season: s,
          week: w,
          homeTeam,
          awayTeam
        })),
        context: [],
        diagnostics: {},
        trainingMetadata: {},
        btDebug: {},
        modelSummary: { season, generated_at: new Date().toISOString() }
      };
    },
    async writeArtifacts() {},
    async updateHistoricalArtifacts() {},
    async runWeeklyWorkflow() {}
  }));
}
