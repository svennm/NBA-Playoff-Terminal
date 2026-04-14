// NBA.com Stats - Public endpoints, no key required
// Team/player stats, league leaders, playoff picture

const BASE = 'https://stats.nba.com/stats';
const CDN = 'https://cdn.nba.com/static/json';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'Accept': 'application/json'
};

async function safeFetch(url, label) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[NBA:${label}] ${e.message}`);
    return null;
  }
}

function parseNbaTable(data) {
  if (!data?.resultSets?.[0]) return [];
  const { headers, rowSet } = data.resultSets[0];
  return rowSet.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

export async function getLeagueLeaders(season = '2025-26', statCategory = 'PTS') {
  const url = `${BASE}/leagueleaders?LeagueID=00&PerMode=PerGame&Scope=S&Season=${season}&SeasonType=Regular+Season&StatCategory=${statCategory}`;
  const data = await safeFetch(url, 'leaders');
  return parseNbaTable(data);
}

export async function getTeamStats(season = '2025-26') {
  const url = `${BASE}/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${season}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
  const data = await safeFetch(url, 'team-stats');
  return parseNbaTable(data);
}

export async function getPlayerGameLog(playerId, season = '2025-26') {
  const url = `${BASE}/playergamelog?DateFrom=&DateTo=&LeagueID=00&PlayerID=${playerId}&Season=${season}&SeasonType=Regular+Season`;
  const data = await safeFetch(url, `gamelog-${playerId}`);
  return parseNbaTable(data);
}

export async function getTodayScoreboard() {
  const data = await safeFetch(
    'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json',
    'cdn-scoreboard'
  );
  return data?.scoreboard || null;
}

export async function getLiveBoxScore(gameId) {
  const data = await safeFetch(
    `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`,
    `boxscore-${gameId}`
  );
  return data?.game || null;
}

export async function getPlayoffBracket() {
  const data = await safeFetch(
    'https://cdn.nba.com/static/json/liveData/playoffBracket/playoffBracket_00.json',
    'playoff-bracket'
  );
  return data;
}

export default {
  getLeagueLeaders,
  getTeamStats,
  getPlayerGameLog,
  getTodayScoreboard,
  getLiveBoxScore,
  getPlayoffBracket
};
