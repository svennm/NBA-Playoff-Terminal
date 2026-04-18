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

  // Core ESPN sources — these are fast, reliable, and FREE
  // NOTE: Odds API removed from sweep to conserve 20K/month quota
  // ESPN already embeds odds in scoreboard data (spreads, totals, ML)
  // Odds API only used on-demand for book comparison on analysis page
  // Fetch upcoming 3-day schedule alongside scoreboard for complete game coverage
  const fetchUpcoming = async () => {
    try {
      const today = new Date();
      const end = new Date(today); end.setDate(end.getDate() + 3);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(TIMEOUT) });
      const data = await r.json();
      return (data.events || []).map(ev => {
        const comp = ev.competitions?.[0];
        const teams = comp?.competitors || [];
        const home = teams.find(t => t.homeAway === 'home');
        const away = teams.find(t => t.homeAway === 'away');
        return {
          id: ev.id, name: ev.name, shortName: ev.shortName, date: ev.date,
          status: comp?.status?.type?.description || 'Unknown',
          statusDetail: comp?.status?.type?.detail || '',
          clock: comp?.status?.displayClock || '', period: comp?.status?.period || 0,
          home: { name: home?.team?.displayName || '', abbr: home?.team?.abbreviation || '', logo: home?.team?.logo || '', score: home?.score || '0', record: home?.records?.[0]?.summary || '', seed: home?.curatedRank?.current || 0 },
          away: { name: away?.team?.displayName || '', abbr: away?.team?.abbreviation || '', logo: away?.team?.logo || '', score: away?.score || '0', record: away?.records?.[0]?.summary || '', seed: away?.curatedRank?.current || 0 },
          broadcast: comp?.broadcasts?.[0]?.names?.join(', ') || '',
          venue: comp?.venue?.fullName || '',
          odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0, provider: comp.odds[0].provider?.name || '' } : null,
          leaders: (comp?.leaders || []).map(l => ({ category: l.name, leader: l.leaders?.[0] ? { name: l.leaders[0].athlete?.displayName || '', value: l.leaders[0].displayValue || '' } : null }))
        };
      });
    } catch { return []; }
  };

  const results = await Promise.allSettled([
    withTimeout(espn.getScoreboard(), TIMEOUT, 'scoreboard'),
    withTimeout(espn.getStandings(), TIMEOUT, 'standings'),
    withTimeout(espn.getNews(), TIMEOUT, 'news'),
    withTimeout(espn.getInjuries(), TIMEOUT, 'injuries'),
    withTimeout(espn.getTeams(), TIMEOUT, 'teams'),
    withTimeout(espn.getPlayInScoreboard(), TIMEOUT, 'playin'),
    withTimeout(fetchUpcoming(), TIMEOUT, 'upcoming'),
  ]);

  const extract = (i) => results[i].status === 'fulfilled' ? results[i].value : null;

  const regularGames = extract(0) || [];
  const playInGames = extract(5) || [];
  const upcomingGames = extract(6) || [];

  // Merge all game sources, deduplicate by ID, prefer most recent data
  const gameMap = new Map();
  // Upcoming first (base), then scoreboard overwrites with live data, then play-in
  for (const g of upcomingGames) gameMap.set(g.id, g);
  for (const g of regularGames) gameMap.set(g.id, g);
  for (const g of playInGames) if (!gameMap.has(g.id)) gameMap.set(g.id, g);
  const scoreboard = [...gameMap.values()];
  const standings = extract(1) || { east: [], west: [] };
  const news = extract(2) || [];
  const injuries = extract(3) || [];
  const teams = extract(4) || [];
  const oddsData = { data: [] }; // No longer fetched in sweep

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
