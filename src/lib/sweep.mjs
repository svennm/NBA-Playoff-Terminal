// Sweep orchestrator - runs all sources in parallel, caches results
// Lightweight on Vercel serverless — skips slow/blocked sources

import espn from '../sources/espn.mjs';
import odds from '../sources/odds.mjs';
import bdl from '../sources/balldontlie.mjs';

const IS_VERCEL = !!process.env.VERCEL;

let cache = null;
let lastSweep = 0;
const SWEEP_INTERVAL = IS_VERCEL ? 30_000 : 60_000;

// Wrap a promise with a timeout
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

export async function runSweep(force = false) {
  const now = Date.now();
  if (!force && cache && (now - lastSweep) < SWEEP_INTERVAL) {
    return cache;
  }

  console.log(`[SWEEP] Running sweep at ${new Date().toISOString()} (${IS_VERCEL ? 'serverless' : 'local'})`);
  const start = performance.now();
  const TIMEOUT = IS_VERCEL ? 8000 : 15000;

  // Core ESPN sources — these are fast and reliable
  const results = await Promise.allSettled([
    withTimeout(espn.getScoreboard(), TIMEOUT, 'scoreboard'),
    withTimeout(espn.getStandings(), TIMEOUT, 'standings'),
    withTimeout(espn.getNews(), TIMEOUT, 'news'),
    withTimeout(espn.getInjuries(), TIMEOUT, 'injuries'),
    withTimeout(espn.getTeams(), TIMEOUT, 'teams'),
    withTimeout(odds.getOdds(), TIMEOUT, 'odds'),
  ]);

  const extract = (i) => results[i].status === 'fulfilled' ? results[i].value : null;

  const scoreboard = extract(0) || [];
  const standings = extract(1) || { east: [], west: [] };
  const news = extract(2) || [];
  const injuries = extract(3) || [];
  const teams = extract(4) || [];
  const oddsData = extract(5) || { data: [] };

  // Log any failures
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.log(`[SWEEP] Source ${i} failed: ${r.reason?.message}`);
  });

  // Merge ESPN odds into scoreboard games
  const gamesWithOdds = scoreboard.map(game => {
    const matchedOdds = oddsData.data?.find(o => {
      const home = game.home.name.toLowerCase();
      return o.homeTeam?.toLowerCase().includes(home.split(' ').pop()) ||
             home.includes(o.homeTeam?.toLowerCase().split(' ').pop());
    });
    return { ...game, externalOdds: matchedOdds || null };
  });

  // Key injuries for playoff teams
  const keyInjuries = injuries.filter(inj =>
    ['Out', 'Doubtful', 'Questionable'].includes(inj.status)
  ).slice(0, 20);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`[SWEEP] Complete in ${elapsed}ms | ${scoreboard.length} games | ${injuries.length} injuries`);

  cache = {
    timestamp: new Date().toISOString(),
    sweepMs: Number(elapsed),
    sources: {
      espn: {
        scoreboard: !!extract(0),
        standings: !!extract(1),
        news: !!extract(2),
        injuries: !!extract(3)
      },
      odds: { active: !oddsData.error, error: oddsData.error || null },
      balldontlie: { active: bdl.isConfigured() },
      nbastats: { scoreboard: false, leaders: false }
    },
    games: gamesWithOdds,
    standings,
    news,
    injuries: keyInjuries,
    allInjuries: injuries,
    teams,
    topScorers: [],
    teamStats: [],
    playoffBracket: null,
    nbaLive: null
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
