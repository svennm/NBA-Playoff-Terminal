// Sweep orchestrator - runs all sources in parallel, caches results
// Modeled after Crucix's briefing.mjs

import espn from '../sources/espn.mjs';
import odds from '../sources/odds.mjs';
import bdl from '../sources/balldontlie.mjs';
import nba from '../sources/nbastats.mjs';

let cache = null;
let lastSweep = 0;
const SWEEP_INTERVAL = 60_000; // 60 seconds

export async function runSweep(force = false) {
  const now = Date.now();
  if (!force && cache && (now - lastSweep) < SWEEP_INTERVAL) {
    return cache;
  }

  console.log(`[SWEEP] Running full sweep at ${new Date().toISOString()}`);
  const start = performance.now();

  const results = await Promise.allSettled([
    espn.getScoreboard(),
    espn.getStandings(),
    espn.getNews(),
    espn.getInjuries(),
    espn.getTeams(),
    odds.getOdds(),
    nba.getTodayScoreboard(),
    nba.getLeagueLeaders(),
    nba.getTeamStats(),
    nba.getPlayoffBracket()
  ]);

  const extract = (i) => results[i].status === 'fulfilled' ? results[i].value : null;

  const scoreboard = extract(0) || [];
  const standings = extract(1) || { east: [], west: [] };
  const news = extract(2) || [];
  const injuries = extract(3) || [];
  const teams = extract(4) || [];
  const oddsData = extract(5) || { data: [] };
  const nbaScoreboard = extract(6);
  const leaders = extract(7) || [];
  const teamStats = extract(8) || [];
  const playoffBracket = extract(9);

  // Merge ESPN odds into scoreboard games
  const gamesWithOdds = scoreboard.map(game => {
    // Try to match with odds data
    const matchedOdds = oddsData.data?.find(o => {
      const home = game.home.name.toLowerCase();
      const away = game.away.name.toLowerCase();
      return o.homeTeam?.toLowerCase().includes(home.split(' ').pop()) ||
             home.includes(o.homeTeam?.toLowerCase().split(' ').pop());
    });
    return { ...game, externalOdds: matchedOdds || null };
  });

  // Build top performers
  const topScorers = leaders.slice(0, 10).map(p => ({
    name: p.PLAYER || p.PLAYER_NAME || '',
    team: p.TEAM || p.TEAM_ABBREVIATION || '',
    ppg: p.PTS || 0,
    rpg: p.REB || 0,
    apg: p.AST || 0,
    gp: p.GP || 0
  }));

  // Key injuries for playoff teams
  const keyInjuries = injuries.filter(inj =>
    ['Out', 'Doubtful', 'Questionable'].includes(inj.status)
  ).slice(0, 20);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`[SWEEP] Complete in ${elapsed}ms | ${scoreboard.length} games | ${injuries.length} injuries | ${news.length} articles`);

  cache = {
    timestamp: new Date().toISOString(),
    sweepMs: Number(elapsed),
    sources: {
      espn: { scoreboard: true, standings: true, news: true, injuries: true },
      odds: { active: !oddsData.error, error: oddsData.error || null },
      balldontlie: { active: bdl.isConfigured() },
      nbastats: { scoreboard: !!nbaScoreboard, leaders: leaders.length > 0 }
    },
    games: gamesWithOdds,
    standings,
    news,
    injuries: keyInjuries,
    allInjuries: injuries,
    teams,
    topScorers,
    teamStats: teamStats.slice(0, 30),
    playoffBracket,
    nbaLive: nbaScoreboard
  };

  lastSweep = now;
  return cache;
}

export function getCache() {
  return cache;
}

export function invalidateCache() {
  cache = null;
  lastSweep = 0;
}
