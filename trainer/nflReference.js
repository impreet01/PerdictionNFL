// trainer/nflReference.js
// NFL reference data including divisions, stadiums, and team metadata.
//
// This module provides:
// - Team division mappings (1999-2024+)
// - Stadium locations for travel distance calculations
// - Historical team relocations
// - Conference and division structure

/**
 * NFL Division structure (post-2002 realignment).
 * Note: Pre-2002 had different divisions, but we use current for simplicity.
 */
export const NFL_DIVISIONS = {
  // AFC East
  BUF: { conference: "AFC", division: "AFC East" },
  MIA: { conference: "AFC", division: "AFC East" },
  NE: { conference: "AFC", division: "AFC East" },
  NYJ: { conference: "AFC", division: "AFC East" },

  // AFC North
  BAL: { conference: "AFC", division: "AFC North" },
  CIN: { conference: "AFC", division: "AFC North" },
  CLE: { conference: "AFC", division: "AFC North" },
  PIT: { conference: "AFC", division: "AFC North" },

  // AFC South
  HOU: { conference: "AFC", division: "AFC South" },
  IND: { conference: "AFC", division: "AFC South" },
  JAC: { conference: "AFC", division: "AFC South" },
  JAX: { conference: "AFC", division: "AFC South" }, // Alternate abbreviation
  TEN: { conference: "AFC", division: "AFC South" },

  // AFC West
  DEN: { conference: "AFC", division: "AFC West" },
  KC: { conference: "AFC", division: "AFC West" },
  LV: { conference: "AFC", division: "AFC West" },
  OAK: { conference: "AFC", division: "AFC West" }, // Pre-2020 Raiders
  LAC: { conference: "AFC", division: "AFC West" },
  SD: { conference: "AFC", division: "AFC West" }, // Pre-2017 Chargers

  // NFC East
  DAL: { conference: "NFC", division: "NFC East" },
  NYG: { conference: "NFC", division: "NFC East" },
  PHI: { conference: "NFC", division: "NFC East" },
  WAS: { conference: "NFC", division: "NFC East" },

  // NFC North
  CHI: { conference: "NFC", division: "NFC North" },
  DET: { conference: "NFC", division: "NFC North" },
  GB: { conference: "NFC", division: "NFC North" },
  MIN: { conference: "NFC", division: "NFC North" },

  // NFC South
  ATL: { conference: "NFC", division: "NFC South" },
  CAR: { conference: "NFC", division: "NFC South" },
  NO: { conference: "NFC", division: "NFC South" },
  TB: { conference: "NFC", division: "NFC South" },

  // NFC West
  ARI: { conference: "NFC", division: "NFC West" },
  LAR: { conference: "NFC", division: "NFC West" },
  LA: { conference: "NFC", division: "NFC West" }, // 2016 Rams
  STL: { conference: "NFC", division: "NFC West" }, // Pre-2016 Rams
  SF: { conference: "NFC", division: "NFC West" },
  SEA: { conference: "NFC", division: "NFC West" }
};

/**
 * Stadium locations for travel distance calculations.
 * Coordinates are approximate stadium centers (latitude, longitude).
 */
export const STADIUM_LOCATIONS = {
  // AFC East
  BUF: { city: "Buffalo, NY", lat: 42.7738, lon: -78.7870 },
  MIA: { city: "Miami Gardens, FL", lat: 25.9580, lon: -80.2389 },
  NE: { city: "Foxborough, MA", lat: 42.0909, lon: -71.2643 },
  NYJ: { city: "East Rutherford, NJ", lat: 40.8135, lon: -74.0745 },

  // AFC North
  BAL: { city: "Baltimore, MD", lat: 39.2780, lon: -76.6227 },
  CIN: { city: "Cincinnati, OH", lat: 39.0954, lon: -84.5160 },
  CLE: { city: "Cleveland, OH", lat: 41.5061, lon: -81.6995 },
  PIT: { city: "Pittsburgh, PA", lat: 40.4468, lon: -80.0158 },

  // AFC South
  HOU: { city: "Houston, TX", lat: 29.6847, lon: -95.4107 },
  IND: { city: "Indianapolis, IN", lat: 39.7601, lon: -86.1639 },
  JAC: { city: "Jacksonville, FL", lat: 30.3240, lon: -81.6373 },
  JAX: { city: "Jacksonville, FL", lat: 30.3240, lon: -81.6373 },
  TEN: { city: "Nashville, TN", lat: 36.1665, lon: -86.7713 },

  // AFC West
  DEN: { city: "Denver, CO", lat: 39.7439, lon: -105.0201 },
  KC: { city: "Kansas City, MO", lat: 39.0489, lon: -94.4839 },
  LV: { city: "Las Vegas, NV", lat: 36.0909, lon: -115.1833 },
  OAK: { city: "Oakland, CA", lat: 37.7516, lon: -122.2005 },
  LAC: { city: "Inglewood, CA", lat: 33.9535, lon: -118.3390 },
  SD: { city: "San Diego, CA", lat: 32.7831, lon: -117.1194 },

  // NFC East
  DAL: { city: "Arlington, TX", lat: 32.7473, lon: -97.0945 },
  NYG: { city: "East Rutherford, NJ", lat: 40.8135, lon: -74.0745 },
  PHI: { city: "Philadelphia, PA", lat: 39.9008, lon: -75.1675 },
  WAS: { city: "Landover, MD", lat: 38.9076, lon: -76.8645 },

  // NFC North
  CHI: { city: "Chicago, IL", lat: 41.8623, lon: -87.6167 },
  DET: { city: "Detroit, MI", lat: 42.3400, lon: -83.0456 },
  GB: { city: "Green Bay, WI", lat: 44.5013, lon: -88.0622 },
  MIN: { city: "Minneapolis, MN", lat: 44.9738, lon: -93.2575 },

  // NFC South
  ATL: { city: "Atlanta, GA", lat: 33.7555, lon: -84.4008 },
  CAR: { city: "Charlotte, NC", lat: 35.2258, lon: -80.8529 },
  NO: { city: "New Orleans, LA", lat: 29.9511, lon: -90.0812 },
  TB: { city: "Tampa, FL", lat: 27.9759, lon: -82.5033 },

  // NFC West
  ARI: { city: "Glendale, AZ", lat: 33.5276, lon: -112.2626 },
  LAR: { city: "Inglewood, CA", lat: 33.9535, lon: -118.3390 },
  LA: { city: "Los Angeles, CA", lat: 34.0141, lon: -118.2879 },
  STL: { city: "St. Louis, MO", lat: 38.6328, lon: -90.1884 },
  SF: { city: "Santa Clara, CA", lat: 37.4032, lon: -121.9698 },
  SEA: { city: "Seattle, WA", lat: 47.5952, lon: -122.3316 }
};

/**
 * Get division info for a team.
 * @param {string} team - Team abbreviation (e.g., "BUF")
 * @returns {Object|null} Division info or null if not found
 */
export function getTeamDivision(team) {
  if (!team) return null;
  const normalized = String(team).trim().toUpperCase();
  return NFL_DIVISIONS[normalized] || null;
}

/**
 * Check if two teams are in the same division.
 * @param {string} team1 - First team abbreviation
 * @param {string} team2 - Second team abbreviation
 * @returns {boolean} True if both teams are in the same division
 */
export function isDivisionalGame(team1, team2) {
  const div1 = getTeamDivision(team1);
  const div2 = getTeamDivision(team2);

  if (!div1 || !div2) return false;

  return div1.division === div2.division;
}

/**
 * Check if two teams are in the same conference.
 * @param {string} team1 - First team abbreviation
 * @param {string} team2 - Second team abbreviation
 * @returns {boolean} True if both teams are in the same conference
 */
export function isConferenceGame(team1, team2) {
  const div1 = getTeamDivision(team1);
  const div2 = getTeamDivision(team2);

  if (!div1 || !div2) return false;

  return div1.conference === div2.conference;
}

/**
 * Get stadium location for a team.
 * @param {string} team - Team abbreviation
 * @returns {Object|null} Stadium location or null if not found
 */
export function getStadiumLocation(team) {
  if (!team) return null;
  const normalized = String(team).trim().toUpperCase();
  return STADIUM_LOCATIONS[normalized] || null;
}

/**
 * Calculate great circle distance between two points using Haversine formula.
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in miles
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 10) / 10; // Round to 1 decimal place
}

/**
 * Calculate travel distance between two teams.
 * @param {string} fromTeam - Away team abbreviation
 * @param {string} toTeam - Home team abbreviation
 * @returns {number|null} Distance in miles or null if locations not found
 */
export function calculateTravelDistance(fromTeam, toTeam) {
  const fromLoc = getStadiumLocation(fromTeam);
  const toLoc = getStadiumLocation(toTeam);

  if (!fromLoc || !toLoc) return null;

  return calculateDistance(fromLoc.lat, fromLoc.lon, toLoc.lat, toLoc.lon);
}

/**
 * Get division rivals for a team.
 * @param {string} team - Team abbreviation
 * @returns {Array<string>} List of division rival team abbreviations
 */
export function getDivisionRivals(team) {
  const teamDiv = getTeamDivision(team);
  if (!teamDiv) return [];

  return Object.entries(NFL_DIVISIONS)
    .filter(([t, div]) => div.division === teamDiv.division && t !== team.toUpperCase())
    .map(([t, _]) => t);
}

export default {
  NFL_DIVISIONS,
  STADIUM_LOCATIONS,
  getTeamDivision,
  isDivisionalGame,
  isConferenceGame,
  getStadiumLocation,
  calculateDistance,
  calculateTravelDistance,
  getDivisionRivals
};
