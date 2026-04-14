// BallDontLie API v2 - Free tier available
// Sign up at https://www.balldontlie.io for API key
// Set BDL_API_KEY in .env or environment

const BASE = 'https://api.balldontlie.io/v1';

function getHeaders() {
  const key = process.env.BDL_API_KEY || '';
  if (!key) return {};
  return { Authorization: key };
}

async function safeFetch(url, label) {
  try {
    const headers = getHeaders();
    if (!headers.Authorization) return null;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[BDL:${label}] ${e.message}`);
    return null;
  }
}

export async function getPlayers(search = '', perPage = 25) {
  const params = new URLSearchParams({ per_page: perPage });
  if (search) params.set('search', search);
  const data = await safeFetch(`${BASE}/players?${params}`, 'players');
  return data?.data || [];
}

export async function getSeasonAverages(playerIds = [], season = 2025) {
  if (!playerIds.length) return [];
  const params = new URLSearchParams({ season });
  playerIds.forEach(id => params.append('player_ids[]', id));
  const data = await safeFetch(`${BASE}/season_averages?${params}`, 'averages');
  return data?.data || [];
}

export async function getGames(dates = [], seasons = [2025], perPage = 25) {
  const params = new URLSearchParams({ per_page: perPage });
  dates.forEach(d => params.append('dates[]', d));
  seasons.forEach(s => params.append('seasons[]', s));
  const data = await safeFetch(`${BASE}/games?${params}`, 'games');
  return data?.data || [];
}

export async function getStats(gameIds = [], playerIds = [], perPage = 25) {
  const params = new URLSearchParams({ per_page: perPage });
  gameIds.forEach(id => params.append('game_ids[]', id));
  playerIds.forEach(id => params.append('player_ids[]', id));
  const data = await safeFetch(`${BASE}/stats?${params}`, 'stats');
  return data?.data || [];
}

export async function getTeamSeasonStats() {
  const data = await safeFetch(`${BASE}/teams`, 'teams');
  return data?.data || [];
}

export function isConfigured() {
  return !!process.env.BDL_API_KEY;
}

export default { getPlayers, getSeasonAverages, getGames, getStats, getTeamSeasonStats, isConfigured };
