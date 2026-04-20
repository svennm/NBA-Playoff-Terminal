import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { runSweep, getCache } from './lib/sweep.mjs';
import espn from './sources/espn.mjs';
import odds from './sources/odds.mjs';
import store from './lib/store.mjs';
import polymarket from './sources/polymarket.mjs';
import soccer from './sources/soccer.mjs';
import cache, { TTL } from './lib/cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// SSE clients
const clients = new Set();

// Serve dashboard
app.use(express.static(join(__dirname, '..', 'dashboard', 'public')));

// API: Full sweep data
app.get('/api/sweep', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await runSweep(force);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Live scores only
app.get('/api/scores', async (req, res) => {
  const data = getCache();
  res.json(data?.games || []);
});

// API: Standings
app.get('/api/standings', async (req, res) => {
  const data = getCache();
  res.json(data?.standings || {});
});

// API: Injuries
app.get('/api/injuries', async (req, res) => {
  const data = getCache();
  res.json(data?.allInjuries || []);
});

// API: News
app.get('/api/news', async (req, res) => {
  const data = getCache();
  res.json(data?.news || []);
});

// API: Odds
app.get('/api/odds', async (req, res) => {
  const data = getCache();
  const odds = data?.games?.filter(g => g.externalOdds || g.odds) || [];
  res.json(odds);
});

// API: All teams list (cached 1hr)
app.get('/api/teams', async (req, res) => {
  const cached = cache.get('teams');
  if (cached) return res.json(cached);
  const data = getCache();
  if (data?.teams?.length) {
    cache.set('teams', data.teams, TTL.TEAMS_LIST);
    return res.json(data.teams);
  }
  const teams = await espn.getTeams();
  cache.set('teams', teams, TTL.TEAMS_LIST);
  res.json(teams);
});

// API: Team detail + stats (cached 15min per team)
app.get('/api/teams/:id', async (req, res) => {
  const cacheKey = `team-${req.params.id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [detail, stats, roster] = await Promise.all([
      espn.getTeamDetail(req.params.id),
      espn.getTeamStats(req.params.id),
      espn.getPlayerStats(req.params.id)
    ]);
    const allInjuries = getCache()?.allInjuries || [];
    const teamInjuries = allInjuries.filter(i =>
      detail && (i.team === detail.name || i.teamAbbr === detail.abbr)
    );
    const result = { detail, stats, roster, injuries: teamInjuries };
    cache.set(cacheKey, result, TTL.TEAM_DETAIL);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Upcoming NBA schedule (next 7 days)
app.get('/api/schedule', async (req, res) => {
  const ck = 'nba-schedule';
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const data = await r.json();

    const games = (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const teams = comp?.competitors || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      return {
        id: ev.id, name: ev.shortName || ev.name, date: ev.date,
        status: comp?.status?.type?.description || 'Scheduled',
        home: { name: home?.team?.displayName || 'TBD', abbr: home?.team?.abbreviation || 'TBD', logo: home?.team?.logo || '' },
        away: { name: away?.team?.displayName || 'TBD', abbr: away?.team?.abbreviation || 'TBD', logo: away?.team?.logo || '' },
        odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0, provider: comp.odds[0].provider?.name || '' } : null,
        broadcast: comp?.broadcasts?.[0]?.names?.join(', ') || '',
        note: comp?.notes?.[0]?.headline || ''
      };
    });

    cache.set(ck, games, 10 * 60_000);
    res.json(games);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Hypothetical lines for a scheduled/future game
// Uses Poisson model on historical gamelogs — NO Odds API calls
app.get('/api/schedule/lines/:gameIndex', async (req, res) => {
  const window = req.query.window || 'season';
  const ck = `schedule-lines-${req.params.gameIndex}-${window}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    // Get schedule directly from ESPN
    const today = new Date();
    const end = new Date(today); end.setDate(end.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const schedUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
    const schedFetch = await fetch(schedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const schedData = await schedFetch.json();
    const schedule = (schedData.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const teams = comp?.competitors || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      return {
        id: ev.id, date: ev.date, status: comp?.status?.type?.description || 'Scheduled',
        home: { name: home?.team?.displayName || 'TBD', abbr: home?.team?.abbreviation || 'TBD', logo: home?.team?.logo || '' },
        away: { name: away?.team?.displayName || 'TBD', abbr: away?.team?.abbreviation || 'TBD', logo: away?.team?.logo || '' },
        odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0, provider: comp.odds[0].provider?.name || '' } : null,
        broadcast: comp?.broadcasts?.[0]?.names?.join(', ') || ''
      };
    });

    const game = schedule[parseInt(req.params.gameIndex)];
    if (!game) return res.status(404).json({ error: 'Game not found at index ' + req.params.gameIndex });
    if (game.home.abbr === 'TBD' || game.away.abbr === 'TBD') return res.status(400).json({ error: 'TBD matchup — teams not yet determined' });

    // Get teams list to find IDs
    const teams = await espn.getTeams();
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    const poissonCdf = (k, lam) => {
      let sum = 0;
      for (let i = 0; i <= Math.floor(k); i++) {
        let term = Math.exp(-lam);
        for (let j = 1; j <= i; j++) term *= lam / j;
        sum += term;
      }
      return Math.min(sum, 1);
    };
    const toAmerican = (prob) => prob >= 0.5
      ? Math.round(-100 * prob / (1 - prob))
      : Math.round(100 * (1 - prob) / prob);

    const isPlayoffWindow = window === 'playoffs' || window === 'playoffs2026' || window.startsWith('PL');

    const analyzeTeam = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const roster = await espn.getPlayerStats(teamId);
      const top = roster.slice(0, 10);
      const gamelogs = await Promise.allSettled(
        top.map(p => espn.getPlayerGamelog(p.id))
      );
      const playoffData = isPlayoffWindow ? await Promise.allSettled(
        top.map(p => espn.getPlayerPlayoffStats(p.id))
      ) : null;

      const rows = [];
      for (let i = 0; i < top.length; i++) {
        const player = top[i];
        const gl = gamelogs[i].status === 'fulfilled' ? gamelogs[i].value : null;
        const po = playoffData?.[i]?.status === 'fulfilled' ? playoffData[i].value : null;

        const statKeys = ['PTS', 'REB', 'AST', '3PM', 'FGM', 'FTM', 'STL', 'BLK'];
        for (const key of statKeys) {
          let values;
          let seasonMean = null;

          if (window === 'playoffs') {
            values = (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (values.length < 3) continue;
          } else if (window === 'playoffs2026') {
            values = (po?.games || []).filter(g => g.season === 2026).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (values.length < 2) continue;
          } else if (window.startsWith('PL')) {
            const plSize = parseInt(window.slice(2));
            const allPo = (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            values = allPo.slice(0, Math.min(plSize, allPo.length));
            if (values.length < 2) continue;
          } else {
            if (!gl?.games?.length) continue;
            const all = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (all.length < 5) continue;
            const windowSize = window === 'season' ? all.length : window.startsWith('L') ? parseInt(window.slice(1)) || all.length : all.length;
            values = all.slice(0, Math.min(windowSize, all.length));
            if (values.length < 3) continue;
            seasonMean = +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1);
          }

          // Also get season baseline for non-season windows
          if (!seasonMean && gl?.games?.length && window !== 'season') {
            const sv = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (sv.length >= 5) seasonMean = +(sv.reduce((a, b) => a + b, 0) / sv.length).toFixed(1);
          }

          const n = values.length;
          const mean = values.reduce((a, b) => a + b, 0) / n;
          if (mean < 0.3) continue;
          const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
          const stdDev = Math.sqrt(variance);
          const dispersion = mean > 0 ? variance / mean : 0;

          const line = Math.floor(mean) + 0.5;
          const overProb = 1 - poissonCdf(line, mean);
          const underProb = poissonCdf(line, mean);
          const actualOver = values.filter(v => v > line).length;

          let fit = 'Poor';
          if (Math.abs(dispersion - 1) < 0.5) fit = 'Excellent';
          else if (Math.abs(dispersion - 1) < 1) fit = 'Good';
          else if (Math.abs(dispersion - 1) < 2) fit = 'Fair';

          rows.push({
            player: player.name, playerId: player.id, team: teamAbbr,
            headshot: player.headshot || '', stat: key, line,
            mean: +mean.toFixed(1), stdDev: +stdDev.toFixed(1), games: n,
            seasonMean,
            trend: seasonMean ? +(mean - seasonMean).toFixed(1) : null,
            modelOverProb: +(overProb * 100).toFixed(1),
            modelUnderProb: +(underProb * 100).toFixed(1),
            modelOverOdds: toAmerican(overProb),
            modelUnderOdds: toAmerican(underProb),
            actualOverPct: +(actualOver / n * 100).toFixed(1),
            poissonFit: fit, dispersion: +dispersion.toFixed(3),
            consistency: stdDev / mean < 0.2 ? 'High' : stdDev / mean < 0.35 ? 'Medium' : 'Low'
          });
        }
      }
      return rows;
    };

    const [homeRows, awayRows] = await Promise.all([
      analyzeTeam(homeTeam?.id, game.home.abbr),
      analyzeTeam(awayTeam?.id, game.away.abbr)
    ]);

    const result = {
      game: {
        home: game.home, away: game.away,
        date: game.date, odds: game.odds,
        broadcast: game.broadcast, note: game.note
      },
      window,
      rows: [...awayRows, ...homeRows],
      source: 'Poisson model (ESPN gamelogs)',
      summary: {
        total: awayRows.length + homeRows.length,
        playersAnalyzed: new Set([...awayRows, ...homeRows].map(r => r.playerId)).size
      }
    };

    cache.set(ck, result, 30 * 60_000); // 30 min cache — historical data doesn't change fast
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Upcoming UCL schedule
app.get('/api/soccer/:league/schedule', async (req, res) => {
  const ck = `soccer-schedule-${req.params.league}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 14);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${req.params.league}/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const data = await r.json();

    const games = (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const teams = comp?.competitors || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      return {
        id: ev.id, name: ev.shortName || ev.name, date: ev.date,
        status: comp?.status?.type?.description || 'Scheduled',
        home: { name: home?.team?.displayName || 'TBD', abbr: home?.team?.abbreviation || 'TBD', logo: home?.team?.logo || '' },
        away: { name: away?.team?.displayName || 'TBD', abbr: away?.team?.abbreviation || 'TBD', logo: away?.team?.logo || '' },
        odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0, provider: comp.odds[0].provider?.name || '' } : null,
        aggregate: comp?.notes?.[0]?.headline || ''
      };
    });

    cache.set(ck, games, 10 * 60_000);
    res.json(games);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Player overview with season stats + shooting splits from gamelog (cached 30min)
app.get('/api/players/:id', async (req, res) => {
  const cacheKey = `player-${req.params.id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Fetch overview + gamelog in parallel
    const [data, gamelog] = await Promise.all([
      espn.getPlayerOverview(req.params.id),
      espn.getPlayerGamelog(req.params.id)
    ]);

    if (!data) return res.json({ error: 'Player not found' });

    // Parse gamelog to get FGM/FGA/3PM/3PA/FTM/FTA averages
    if (gamelog?.games?.length) {
      let fgm = 0, fga = 0, tpm = 0, tpa = 0, ftm = 0, fta = 0;
      let n = 0;
      for (const g of gamelog.games) {
        const s = g.stats;
        // Format: "9-18"
        const fg = (s['fieldGoalsMade-fieldGoalsAttempted'] || s['_FG'] || '').split('-');
        const tp = (s['threePointFieldGoalsMade-threePointFieldGoalsAttempted'] || s['_3PT'] || '').split('-');
        const ft = (s['freeThrowsMade-freeThrowsAttempted'] || s['_FT'] || '').split('-');
        if (fg.length === 2) { fgm += parseFloat(fg[0]) || 0; fga += parseFloat(fg[1]) || 0; }
        if (tp.length === 2) { tpm += parseFloat(tp[0]) || 0; tpa += parseFloat(tp[1]) || 0; }
        if (ft.length === 2) { ftm += parseFloat(ft[0]) || 0; fta += parseFloat(ft[1]) || 0; }
        n++;
      }
      if (n > 0) {
        // Add computed shooting stats to season data
        data.season = data.season || {};
        data.season.fgm = (fgm / n).toFixed(1);
        data.season.fga = (fga / n).toFixed(1);
        data.season.tpm = (tpm / n).toFixed(1);
        data.season.tpa = (tpa / n).toFixed(1);
        data.season.ftm = (ftm / n).toFixed(1);
        data.season.fta = (fta / n).toFixed(1);
        data.season.fgmTotal = fgm;
        data.season.fgaTotal = fga;
        data.season.tpmTotal = tpm;
        data.season.tpaTotal = tpa;
        data.season.ftmTotal = ftm;
        data.season.ftaTotal = fta;
        data.season.gamelogGames = n;
      }
    }

    // Fallback: estimate FGM/FGA from overview stats if gamelog didn't provide them
    if (data.season && !data.season.fgm) {
      const s = data.season;
      const gp = parseFloat(s.gamesPlayed) || 1;
      const pts = parseFloat(s.avgPoints) || 0;
      const fgPct = parseFloat(s.fieldGoalPct) / 100 || 0.45;
      const tpPct = parseFloat(s.threePointPct) / 100 || 0.35;
      const ftPct = parseFloat(s.freeThrowPct) / 100 || 0.75;
      // Estimate: PTS = 2*FGM + 3PM + FTM, with FG% and 3P%
      // Rough: assume ~30% of FGA are 3PA
      const estFGA = pts / (2 * fgPct + 0.3 * tpPct);
      const estFGM = estFGA * fgPct;
      const est3PA = estFGA * 0.3;
      const est3PM = est3PA * tpPct;
      s.fgm = s.fgm || estFGM.toFixed(1);
      s.fga = s.fga || estFGA.toFixed(1);
      s.tpm = s.tpm || est3PM.toFixed(1);
      s.tpa = s.tpa || est3PA.toFixed(1);
      s.ftm = s.ftm || (pts - 2 * estFGM - est3PM > 0 ? ((pts - 2 * estFGM - est3PM) / ftPct * ftPct).toFixed(1) : '0');
      s.fta = s.fta || (parseFloat(s.ftm || 0) / ftPct).toFixed(1);
      s._estimated = true;
    }

    cache.set(cacheKey, data, TTL.PLAYER_STATS);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Team game-by-game schedule with windowed stats (cached 30min)
app.get('/api/teams/:id/games', async (req, res) => {
  const cacheKey = `team-games-${req.params.id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const games = await espn.getTeamSchedule(req.params.id);

    // Compute rolling stats
    const allScores = games.map(g => parseInt(g.score) || 0);
    const allOpp = games.map(g => parseInt(g.oppScore) || 0);
    const allWins = games.map(g => g.won ? 1 : 0);

    const computeWindow = (scores, oppScores, wins, start, len) => {
      const s = scores.slice(start, start + len);
      const o = oppScores.slice(start, start + len);
      const w = wins.slice(start, start + len);
      if (!s.length) return null;
      const n = s.length;
      const ppg = s.reduce((a, b) => a + b, 0) / n;
      const oppg = o.reduce((a, b) => a + b, 0) / n;
      const winCount = w.reduce((a, b) => a + b, 0);
      const margin = s.map((v, i) => v - o[i]);
      const avgMargin = margin.reduce((a, b) => a + b, 0) / n;
      // Std dev of scoring
      const mean = ppg;
      const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1 || 1);
      return {
        games: n,
        wins: winCount,
        losses: n - winCount,
        winPct: +(winCount / n * 100).toFixed(1),
        ppg: +ppg.toFixed(1),
        oppg: +oppg.toFixed(1),
        diff: +avgMargin.toFixed(1),
        scoringStdDev: +Math.sqrt(variance).toFixed(1),
        homeWins: 0, awayWins: 0 // computed below
      };
    };

    // Full season
    const full = computeWindow(allScores, allOpp, allWins, 0, games.length);

    // Precomputed windows
    const windows = {};
    for (const w of [5, 10, 15, 20, 30]) {
      if (games.length >= w) {
        windows[`L${w}`] = computeWindow(allScores, allOpp, allWins, games.length - w, w);
      }
    }

    // Home vs away splits
    const homeGames = games.filter(g => g.home);
    const awayGames = games.filter(g => !g.home);
    const homeSplit = computeWindow(
      homeGames.map(g => parseInt(g.score) || 0),
      homeGames.map(g => parseInt(g.oppScore) || 0),
      homeGames.map(g => g.won ? 1 : 0),
      0, homeGames.length
    );
    const awaySplit = computeWindow(
      awayGames.map(g => parseInt(g.score) || 0),
      awayGames.map(g => parseInt(g.oppScore) || 0),
      awayGames.map(g => g.won ? 1 : 0),
      0, awayGames.length
    );

    const result = { games, full, windows, homeSplit, awaySplit, totalGames: games.length };
    cache.set(cacheKey, result, TTL.TEAM_DETAIL);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Player historical playoff stats (cached 1hr)
app.get('/api/players/:id/playoffs', async (req, res) => {
  const cacheKey = `playoffs-${req.params.id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await espn.getPlayerPlayoffStats(req.params.id);

    // Compute averages from playoff games
    if (data.games.length) {
      const parse = (s, key) => parseFloat(s[key] || '0');
      const parseMade = (s, key) => {
        const val = s[key] || '0-0';
        const parts = val.split('-');
        return { made: parseFloat(parts[0]) || 0, att: parseFloat(parts[1]) || 0 };
      };

      const n = data.games.length;
      let pts=0, reb=0, ast=0, stl=0, blk=0, to=0, min=0, fgm=0, fga=0, tpm=0, tpa=0, ftm=0, fta=0;
      for (const g of data.games) {
        const s = g.stats;
        pts += parse(s, '_PTS');
        reb += parse(s, '_REB');
        ast += parse(s, '_AST');
        stl += parse(s, '_STL');
        blk += parse(s, '_BLK');
        to += parse(s, '_TO');
        min += parse(s, '_MIN');
        const fg = parseMade(s, '_FG');
        fgm += fg.made; fga += fg.att;
        const tp = parseMade(s, '_3PT');
        tpm += tp.made; tpa += tp.att;
        const ft = parseMade(s, '_FT');
        ftm += ft.made; fta += ft.att;
      }

      data.careerPlayoffComputed = {
        gp: n,
        ppg: +(pts/n).toFixed(1), rpg: +(reb/n).toFixed(1), apg: +(ast/n).toFixed(1),
        spg: +(stl/n).toFixed(1), bpg: +(blk/n).toFixed(1), topg: +(to/n).toFixed(1),
        mpg: +(min/n).toFixed(1),
        fgm: +(fgm/n).toFixed(1), fga: +(fga/n).toFixed(1),
        fgPct: fga > 0 ? +(fgm/fga*100).toFixed(1) : 0,
        tpm: +(tpm/n).toFixed(1), tpa: +(tpa/n).toFixed(1),
        tpPct: tpa > 0 ? +(tpm/tpa*100).toFixed(1) : 0,
        ftm: +(ftm/n).toFixed(1), fta: +(fta/n).toFixed(1),
        ftPct: fta > 0 ? +(ftm/fta*100).toFixed(1) : 0
      };

      // Per-season playoff averages with full shooting splits
      const bySeason = {};
      for (const g of data.games) {
        if (!bySeason[g.season]) bySeason[g.season] = [];
        bySeason[g.season].push(g);
      }
      data.bySeason = {};
      for (const [yr, games] of Object.entries(bySeason)) {
        const sn = games.length;
        let sp=0, sr=0, sa=0, sfgm=0, sfga=0, stpm=0, stpa=0, sftm=0, sfta=0;
        for (const g of games) {
          sp += parse(g.stats,'_PTS'); sr += parse(g.stats,'_REB'); sa += parse(g.stats,'_AST');
          const fg = parseMade(g.stats, '_FG');
          sfgm += fg.made; sfga += fg.att;
          const tp = parseMade(g.stats, '_3PT');
          stpm += tp.made; stpa += tp.att;
          const ft = parseMade(g.stats, '_FT');
          sftm += ft.made; sfta += ft.att;
        }
        data.bySeason[yr] = {
          gp: sn,
          ppg: +(sp/sn).toFixed(1), rpg: +(sr/sn).toFixed(1), apg: +(sa/sn).toFixed(1),
          fgm: +(sfgm/sn).toFixed(1), fga: +(sfga/sn).toFixed(1), fgPct: sfga > 0 ? +(sfgm/sfga*100).toFixed(1) : 0,
          tpm: +(stpm/sn).toFixed(1), tpa: +(stpa/sn).toFixed(1), tpPct: stpa > 0 ? +(stpm/stpa*100).toFixed(1) : 0,
          ftm: +(sftm/sn).toFixed(1), fta: +(sfta/sn).toFixed(1), ftPct: sfta > 0 ? +(sftm/sfta*100).toFixed(1) : 0,
          rounds: [...new Set(games.map(g => g.round).filter(Boolean))]
        };
      }
    }

    cache.set(cacheKey, data, TTL.PLAYER_GAMELOG);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Full edge analysis for a game — fetches all player gamelogs + Poisson vs book lines
app.get('/api/analysis/game/:gameIndex', async (req, res) => {
  // ?window=season|L5|L10|L20|L50|playoffs|playoffs2026|PL5|PL10|PL30 (playoff last N)
  const window = req.query.window || 'season';
  const cacheKey = `analysis-game-${req.params.gameIndex}-${window}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const sweepData = getCache() || await runSweep();
    const game = sweepData?.games?.[parseInt(req.params.gameIndex)];
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const teams = sweepData?.teams || await espn.getTeams();
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    const poissonCdf = (k, lam) => {
      let sum = 0;
      for (let i = 0; i <= Math.floor(k); i++) {
        let term = Math.exp(-lam);
        for (let j = 1; j <= i; j++) term *= lam / j;
        sum += term;
      }
      return Math.min(sum, 1);
    };
    const toAmerican = (prob) => prob >= 0.5
      ? Math.round(-100 * prob / (1 - prob))
      : Math.round(100 * (1 - prob) / prob);

    const computePoisson = (values) => {
      const n = values.length;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      if (mean < 0.3) return null;
      const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
      const stdDev = Math.sqrt(variance);
      const dispersion = mean > 0 ? variance / mean : 0;
      const line = Math.floor(mean) + 0.5;
      const overProb = +(1 - poissonCdf(line, mean)).toFixed(4);
      const underProb = +poissonCdf(line, mean).toFixed(4);
      const actualOver = values.filter(v => v > line).length;

      let fit = 'Poor';
      if (Math.abs(dispersion - 1) < 0.5) fit = 'Excellent';
      else if (Math.abs(dispersion - 1) < 1) fit = 'Good';
      else if (Math.abs(dispersion - 1) < 2) fit = 'Fair';

      return {
        line, mean: +mean.toFixed(1), stdDev: +stdDev.toFixed(1), games: n,
        modelOverProb: +(overProb * 100).toFixed(1), modelUnderProb: +(underProb * 100).toFixed(1),
        modelOverOdds: toAmerican(overProb), modelUnderOdds: toAmerican(underProb),
        actualOverPct: +(actualOver / n * 100).toFixed(1),
        poissonFit: fit, dispersion: +dispersion.toFixed(3),
        consistency: stdDev / mean < 0.2 ? 'High' : stdDev / mean < 0.35 ? 'Medium' : 'Low'
      };
    };

    // PL prefix = playoff last N (e.g. PL10 = last 10 playoff games)
    const isPlayoffWindow = window === 'playoffs' || window === 'playoffs2026' || window.startsWith('PL');

    const fetchTeamAnalysis = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const roster = await espn.getPlayerStats(teamId);
      const top = roster.slice(0, 10);

      const gamelogs = await Promise.allSettled(
        top.map(p => espn.getPlayerGamelog(p.id))
      );
      const playoffData = isPlayoffWindow ? await Promise.allSettled(
        top.map(p => espn.getPlayerPlayoffStats(p.id))
      ) : null;

      const results = [];
      const statKeys = ['PTS', 'REB', 'AST', '3PM', 'FGM', 'FTM', 'STL', 'BLK'];

      for (let i = 0; i < top.length; i++) {
        const player = top[i];
        const gl = gamelogs[i].status === 'fulfilled' ? gamelogs[i].value : null;
        const po = playoffData?.[i]?.status === 'fulfilled' ? playoffData[i].value : null;

        for (const key of statKeys) {
          let values;

          if (window === 'playoffs') {
            const poGames = po?.games || [];
            values = poGames.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (values.length < 3) continue;
          } else if (window === 'playoffs2026') {
            const poGames = (po?.games || []).filter(g => g.season === 2026);
            values = poGames.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (values.length < 2) continue;
          } else if (window.startsWith('PL')) {
            // Playoff last N — e.g. PL10 = last 10 career playoff games
            const plSize = parseInt(window.slice(2));
            const poGames = po?.games || [];
            const allPo = poGames.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            values = allPo.slice(0, Math.min(plSize, allPo.length));
            if (values.length < 2) continue;
          } else {
            // Regular season windows (L5, L10, L20, L50, season, or custom LN)
            if (!gl?.games?.length) continue;
            const all = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (all.length < 5) continue;

            const windowSize = window === 'season' ? all.length :
              window.startsWith('L') ? parseInt(window.slice(1)) || all.length : all.length;
            values = all.slice(0, Math.min(windowSize, all.length));
            if (values.length < 3) continue;
          }

          const result = computePoisson(values);
          if (!result) continue;

          // Also compute season baseline for comparison
          let seasonMean = null;
          if (window !== 'season' && gl?.games?.length) {
            const seasonVals = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            if (seasonVals.length >= 5) seasonMean = +(seasonVals.reduce((a, b) => a + b, 0) / seasonVals.length).toFixed(1);
          }

          results.push({
            player: player.name, playerId: player.id, team: teamAbbr,
            headshot: player.headshot || '', stat: key,
            ...result,
            seasonMean,
            trend: seasonMean ? +(result.mean - seasonMean).toFixed(1) : null,
            window
          });
        }
      }
      return results;
    };

    const [homeAnalysis, awayAnalysis] = await Promise.all([
      fetchTeamAnalysis(homeTeam?.id, game.home.abbr),
      fetchTeamAnalysis(awayTeam?.id, game.away.abbr)
    ]);

    const allRows = [...awayAnalysis, ...homeAnalysis];

    const result = {
      game: { home: game.home, away: game.away, date: game.date, odds: game.odds },
      window,
      rows: allRows,
      summary: { total: allRows.length, withEdge: 0 }
    };

    cache.set(cacheKey, result, 5 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Playoff roster analysis — all stat windows for a team's players
// ?windows=season,L5,L10,playoffs2026,playoffsCareer (default)
// Supports any custom window: L7,L15,L25,L40 etc + playoffs + playoffsCareer
app.get('/api/playoffs/team/:teamId', async (req, res) => {
  const windowsParam = req.query.windows || 'season,L5,L10,playoffs2026,playoffsCareer';
  const ck = `playoff-team-${req.params.teamId}-${windowsParam}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const roster = await espn.getPlayerStats(req.params.teamId);
    const top = roster.slice(0, 12);

    // Parse requested windows
    const windowDefs = windowsParam.split(',').map(w => w.trim());
    const needsPlayoffs = windowDefs.some(w => w.includes('playoff') || w.startsWith('PL'));

    const [gamelogs, playoffStats] = await Promise.all([
      Promise.allSettled(top.map(p => espn.getPlayerGamelog(p.id))),
      needsPlayoffs ? Promise.allSettled(top.map(p => espn.getPlayerPlayoffStats(p.id))) : Promise.resolve(top.map(() => ({ status: 'fulfilled', value: null })))
    ]);

    const poissonCdf = (k, lam) => {
      let sum = 0;
      for (let i = 0; i <= Math.floor(k); i++) {
        let term = Math.exp(-lam);
        for (let j = 1; j <= i; j++) term *= lam / j;
        sum += term;
      }
      return Math.min(sum, 1);
    };
    const toAmerican = (prob) => prob >= 0.5
      ? Math.round(-100 * prob / (1 - prob))
      : Math.round(100 * (1 - prob) / prob);

    const computeWindow = (values) => {
      if (!values.length) return null;
      const n = values.length;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      if (mean < 0.3) return null;
      const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
      const stdDev = Math.sqrt(variance);
      const line = Math.floor(mean) + 0.5;
      const overProb = 1 - poissonCdf(line, mean);
      return {
        mean: +mean.toFixed(1), stdDev: +stdDev.toFixed(1), games: n,
        line, overProb: +(overProb * 100).toFixed(1), underProb: +((1 - overProb) * 100).toFixed(1),
        overOdds: toAmerican(overProb), underOdds: toAmerican(1 - overProb),
        hitRate: +(values.filter(v => v > line).length / n * 100).toFixed(1)
      };
    };

    const players = [];
    for (let i = 0; i < top.length; i++) {
      const player = top[i];
      const gl = gamelogs[i].status === 'fulfilled' ? gamelogs[i].value : null;
      const po = playoffStats[i]?.status === 'fulfilled' ? playoffStats[i].value : null;
      if (!gl?.games?.length) continue;

      const statKeys = ['PTS', 'REB', 'AST', '3PM', 'FGM', 'FTM', 'STL', 'BLK'];
      const statLines = {};

      for (const key of statKeys) {
        const all = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
        if (all.length < 5) continue;

        const poGames2026 = (po?.games || []).filter(g => g.season === 2026);
        const poAll = po?.games || [];
        const poVals = poGames2026.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
        const poCareerVals = poAll.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));

        const windows = {};
        for (const w of windowDefs) {
          if (w === 'season') windows.season = computeWindow(all);
          else if (w === 'playoffs2026') windows.playoffs2026 = poVals.length >= 2 ? computeWindow(poVals) : null;
          else if (w === 'playoffsCareer') windows.playoffsCareer = poCareerVals.length >= 3 ? computeWindow(poCareerVals) : null;
          else if (w.startsWith('PL')) {
            // Playoff last N — e.g. PL10 = last 10 career playoff games
            const plN = parseInt(w.slice(2));
            if (plN > 0 && poCareerVals.length >= 2) {
              windows[w] = computeWindow(poCareerVals.slice(0, Math.min(plN, poCareerVals.length)));
            }
          }
          else if (w.startsWith('L')) {
            const n = parseInt(w.slice(1));
            if (n > 0 && all.length >= n) windows[w] = computeWindow(all.slice(0, n));
            else if (n > 0 && all.length >= 3) windows[w] = computeWindow(all.slice(0, Math.min(n, all.length)));
          }
        }

        if (Object.values(windows).some(v => v)) statLines[key] = windows;
      }

      if (Object.keys(statLines).length) {
        players.push({
          id: player.id, name: player.name, headshot: player.headshot || '',
          position: player.position || '', jersey: player.jersey || '',
          seasonAvg: player.seasonAvg || {},
          playoffGames2026: (po?.games || []).filter(g => g.season === 2026).length,
          playoffGamesCareer: po?.totalGames || 0,
          bySeason: po?.bySeason || {},
          stats: statLines
        });
      }
    }

    const result = { teamId: req.params.teamId, windows: windowDefs, players, source: 'ESPN gamelogs + playoff history' };
    cache.set(ck, result, 20 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Live game box score
app.get('/api/game/:eventId/boxscore', async (req, res) => {
  const ck = `boxscore-${req.params.eventId}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${req.params.eventId}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const data = await r.json();

    if (!data.boxscore) return res.status(404).json({ error: 'No boxscore data' });

    // Parse header for game status
    const comp = data.header?.competitions?.[0];
    const status = {
      description: comp?.status?.type?.description || 'Unknown',
      clock: comp?.status?.displayClock || '',
      period: comp?.status?.period || 0,
      completed: comp?.status?.type?.completed || false
    };

    // Parse team box scores
    const teams = (data.boxscore.players || []).map(pg => {
      const labels = pg.statistics?.[0]?.labels || [];
      const athletes = (pg.statistics?.[0]?.athletes || []).map(a => {
        const stats = {};
        labels.forEach((l, i) => { stats[l] = a.stats?.[i] || '0'; });
        return {
          id: a.athlete?.id || '',
          name: a.athlete?.displayName || '',
          shortName: a.athlete?.shortName || '',
          jersey: a.athlete?.jersey || '',
          position: a.athlete?.position?.abbreviation || '',
          headshot: a.athlete?.headshot?.href || '',
          starter: a.starter || false,
          stats
        };
      });
      // Team totals
      const teamStats = {};
      const totals = data.boxscore.teams?.find(t => t.team?.abbreviation === pg.team?.abbreviation);
      if (totals?.statistics) {
        for (const s of totals.statistics) { teamStats[s.label || s.name] = s.displayValue || s.value; }
      }

      return {
        abbr: pg.team?.abbreviation || '',
        name: pg.team?.displayName || '',
        logo: pg.team?.logo || '',
        labels,
        players: athletes,
        totals: teamStats
      };
    });

    // Game odds
    const odds = data.odds?.[0] ? {
      spread: data.odds[0].details || '',
      overUnder: data.odds[0].overUnder || 0,
      provider: data.odds[0].provider?.name || ''
    } : null;

    const result = { eventId: req.params.eventId, status, teams, odds };
    // Short cache for live games, longer for finished
    cache.set(ck, result, status.completed ? 5 * 60_000 : 30_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Playoff bracket — real matchups from ESPN scoreboard
app.get('/api/playoff-bracket', async (req, res) => {
  const ck = 'playoff-bracket-live';
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const today = new Date();
    const end = new Date(today); end.setDate(end.getDate() + 60);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    // Get playoff games + play-in games + standings for seeds
    const [playoffRes, playinRes, standingsData] = await Promise.all([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?seasontype=3&dates=${fmt(today)}-${fmt(end)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
      fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?seasontype=5', { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
      espn.getStandings()
    ]);

    // Build seed map from standings
    const seedMap = {};
    for (const conf of ['east', 'west']) {
      const teams = standingsData[conf] || [];
      teams.sort((a, b) => Number(b.pct) - Number(a.pct));
      teams.forEach((t, i) => { seedMap[t.abbr] = { seed: parseInt(t.seed) || i + 1, conf }; });
    }

    // Parse play-in games
    const playIn = (playinRes.events || []).map(ev => {
      const c = ev.competitions?.[0];
      const away = c?.competitors?.find(t => t.homeAway === 'away');
      const home = c?.competitors?.find(t => t.homeAway === 'home');
      return {
        id: ev.id, date: ev.date,
        status: c?.status?.type?.description || 'Scheduled',
        clock: c?.status?.displayClock || '',
        period: c?.status?.period || 0,
        away: { abbr: away?.team?.abbreviation, name: away?.team?.displayName, logo: away?.team?.logo, score: away?.score || '0', seed: seedMap[away?.team?.abbreviation]?.seed },
        home: { abbr: home?.team?.abbreviation, name: home?.team?.displayName, logo: home?.team?.logo, score: home?.score || '0', seed: seedMap[home?.team?.abbreviation]?.seed }
      };
    });

    // Parse playoff series from scheduled games
    const seriesMap = {};
    for (const ev of playoffRes.events || []) {
      const c = ev.competitions?.[0];
      const away = c?.competitors?.find(t => t.homeAway === 'away');
      const home = c?.competitors?.find(t => t.homeAway === 'home');
      const awayAbbr = away?.team?.abbreviation;
      const homeAbbr = home?.team?.abbreviation;
      if (!awayAbbr || !homeAbbr || awayAbbr.includes('/')) continue;

      const key = [awayAbbr, homeAbbr].sort().join('-');
      if (!seriesMap[key]) {
        seriesMap[key] = {
          away: { abbr: awayAbbr, name: away?.team?.displayName, logo: away?.team?.logo, seed: seedMap[awayAbbr]?.seed },
          home: { abbr: homeAbbr, name: home?.team?.displayName, logo: home?.team?.logo, seed: seedMap[homeAbbr]?.seed },
          conf: seedMap[awayAbbr]?.conf || seedMap[homeAbbr]?.conf || 'unknown',
          round: c?.series?.summary || ev.competitions?.[0]?.notes?.[0]?.headline || '',
          games: []
        };
      }
      seriesMap[key].games.push({
        id: ev.id, date: ev.date,
        status: c?.status?.type?.description || 'Scheduled',
        awayScore: away?.score || '0', homeScore: home?.score || '0',
        clock: c?.status?.displayClock || '', period: c?.status?.period || 0
      });
    }

    // Determine series scores
    const series = Object.values(seriesMap).map(s => {
      let awayWins = 0, homeWins = 0;
      for (const g of s.games) {
        if (g.status === 'Final') {
          if (parseInt(g.awayScore) > parseInt(g.homeScore)) awayWins++;
          else homeWins++;
        }
      }
      return { ...s, awayWins, homeWins, totalGames: s.games.length };
    });

    const result = { playIn, series, seedMap, timestamp: new Date().toISOString() };
    cache.set(ck, result, 60_000); // 1 min cache for live updates
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Soccer edge analysis for a game
app.get('/api/soccer/:league/analysis/:gameIndex', async (req, res) => {
  const ck = `soccer-analysis-${req.params.league}-${req.params.gameIndex}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    // Always use 14-day schedule — consistent with slips/analysis page indexing
    const today = new Date();
    const end = new Date(today); end.setDate(end.getDate() + 14);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const schedUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${req.params.league}/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
    const schedRes = await fetch(schedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const schedData = await schedRes.json();
    const schedGames = (schedData.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const ts = comp?.competitors || [];
      const home = ts.find(t => t.homeAway === 'home');
      const away = ts.find(t => t.homeAway === 'away');
      return {
        home: { name: home?.team?.displayName || '', abbr: home?.team?.abbreviation || '', logo: home?.team?.logo || '' },
        away: { name: away?.team?.displayName || '', abbr: away?.team?.abbreviation || '', logo: away?.team?.logo || '' },
        date: ev.date,
        odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0 } : null
      };
    });
    const game = schedGames[parseInt(req.params.gameIndex)];

    if (!game) return res.status(404).json({ error: 'Game not found' });

    const teams = await soccer.getTeams(req.params.league);
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    const analyzeTeam = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const props = await soccer.getTeamProps(req.params.league, teamId);
      return props.map(p => {
        return p.lines.map(l => ({
          player: p.name, playerId: p.id, team: teamAbbr, position: p.position,
          headshot: p.headshot || '', stat: l.stat, line: l.line,
          mean: l.avg, total: l.total, games: l.gp,
          modelOverProb: l.overProb, modelUnderProb: l.underProb,
          modelOverOdds: l.overOdds, modelUnderOdds: l.underOdds,
          poissonFit: Math.abs((l.avg > 0 ? l.avg : 1) - 1) < 0.5 ? 'Excellent' : Math.abs((l.avg > 0 ? l.avg : 1) - 1) < 1 ? 'Good' : 'Fair',
          dispersion: 1.0, // Poisson assumption
          consistency: l.avg > 0 ? (Math.sqrt(l.avg) / l.avg * 100 < 80 ? 'High' : 'Medium') : 'Low',
          stdDev: +(Math.sqrt(l.avg || 0)).toFixed(2)
        }));
      }).flat();
    };

    const [homeRows, awayRows] = await Promise.all([
      analyzeTeam(homeTeam?.id, game.home.abbr),
      analyzeTeam(awayTeam?.id, game.away.abbr)
    ]);

    const result = {
      game: { home: game.home, away: game.away, date: game.date, odds: game.odds },
      sport: 'soccer',
      rows: [...awayRows, ...homeRows],
      summary: { total: awayRows.length + homeRows.length }
    };

    cache.set(ck, result, 5 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Auto-generate bookmaker lines with 3 models (NBA)
// Uses L10, L20, and full season windows
// === AI PARLAY PICKS ===
// Scans all games, finds model vs book mispricings, builds optimal parlays

app.get('/api/smart-picks', async (req, res) => {
  const ck = 'smart-picks-' + new Date().toISOString().slice(0, 10);
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const sweepData = getCache() || await runSweep();
    const games = (sweepData?.games || []).filter(g => g.status === 'Scheduled' || g.status === 'In Progress');
    if (!games.length) return res.json({ picks: [], reason: 'No upcoming games today' });

    const teams = sweepData?.teams || await espn.getTeams();
    const allEdges = [];

    // Get real book odds for all games (if available)
    let bookOddsMap = {}; // playerName -> { stat -> { line, overOdds, underOdds, book } }
    if (odds.isConfigured()) {
      try {
        const events = await odds.getEvents();
        for (const game of games.slice(0, 8)) {
          const matchEvent = events.data?.find(e => {
            const h = e.home_team?.toLowerCase(); const gh = game.home.name.toLowerCase();
            return h?.includes(gh.split(' ').pop()) || gh.includes(h?.split(' ').pop());
          });
          if (matchEvent) {
            const propsResult = await odds.getPlayerProps(matchEvent.id);
            if (propsResult.data) {
              for (const p of propsResult.data) {
                const key = p.name.toLowerCase();
                if (!bookOddsMap[key]) bookOddsMap[key] = {};
                for (const l of p.lines) {
                  bookOddsMap[key][l.stat] = {
                    line: l.line,
                    overOdds: l.bestOver?.odds || l.over?.odds || -110,
                    underOdds: l.bestUnder?.odds || l.under?.odds || -110,
                    book: l.bestOver?.book || l.over?.book || 'Best'
                  };
                }
              }
            }
          }
        }
      } catch (e) { console.error('[SMART-PICKS] Odds API error:', e.message); }
    }
    const hasBookData = Object.keys(bookOddsMap).length > 0;

    // Analyze each game — find edges using playoff-adjusted Bayesian vs real book lines
    for (let gi = 0; gi < Math.min(games.length, 8); gi++) {
      const game = games[gi];
      const homeTeam = teams.find(t => t.abbr === game.home.abbr);
      const awayTeam = teams.find(t => t.abbr === game.away.abbr);

      for (const [teamId, teamAbbr] of [[homeTeam?.id, game.home.abbr], [awayTeam?.id, game.away.abbr]]) {
        if (!teamId) continue;
        try {
          const roster = await espn.getPlayerStats(teamId);
          const top = roster.slice(0, 8);
          const [gamelogs, playoffStats] = await Promise.all([
            Promise.allSettled(top.map(p => espn.getPlayerGamelog(p.id))),
            Promise.allSettled(top.map(p => espn.getPlayerPlayoffStats(p.id)))
          ]);

          for (let pi = 0; pi < top.length; pi++) {
            const player = top[pi];
            const gl = gamelogs[pi].status === 'fulfilled' ? gamelogs[pi].value : null;
            const po = playoffStats[pi].status === 'fulfilled' ? playoffStats[pi].value : null;
            if (!gl?.games?.length || gl.games.length < 10) continue;

            const statKeys = ['PTS', 'REB', 'AST', '3PM'];
            for (const key of statKeys) {
              const all = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              if (all.length < 10) continue;
              const seasonMean = all.reduce((a, b) => a + b, 0) / all.length;
              if (seasonMean < 1) continue;

              // Career playoff data
              const poAll = (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              const poMean = poAll.length >= 5 ? poAll.reduce((a, b) => a + b, 0) / poAll.length : null;

              // Current year playoff games
              const po2026 = (po?.games || []).filter(g => g.season === 2026).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              const po2026Mean = po2026.length >= 2 ? po2026.reduce((a, b) => a + b, 0) / po2026.length : null;

              // L10 for recent form
              const l10 = all.slice(0, 10);
              const l10Mean = l10.reduce((a, b) => a + b, 0) / l10.length;

              // Playoff-adjusted prior:
              // If player has playoff history, blend season + playoff as prior
              // Weight: 60% season, 40% playoff career (playoffs are different intensity)
              // If they have current playoff games, those get extra weight
              let priorMean = seasonMean;
              let playoffBoost = 0;
              if (poMean !== null) {
                const poWeight = po2026Mean !== null ? 0.5 : 0.3; // more weight if current PO data exists
                priorMean = seasonMean * (1 - poWeight) + poMean * poWeight;
                playoffBoost = +(poMean - seasonMean).toFixed(1);
              }
              // If they have current year playoff games, blend those in too
              if (po2026Mean !== null) {
                priorMean = priorMean * 0.7 + po2026Mean * 0.3;
              }

              // Bayesian posterior (L10 data, playoff-adjusted prior)
              const bay = bayesianUpdate(l10, priorMean, 5);
              if (!bay) continue;

              // Check for real book line
              const bookKey = player.name.toLowerCase();
              const statOddsMap = { 'PTS': 'PTS', 'REB': 'REB', 'AST': 'AST', '3PM': '3PM' };
              const bookLine = bookOddsMap[bookKey]?.[statOddsMap[key] || key];

              // If we have book data but this player/stat has no line, skip
              // (only analyze where books have published lines)
              if (hasBookData && !bookLine) continue;

              const line = bookLine ? bookLine.line : bay.line;

              // If book line differs from model line, recalculate probs at book's line
              let overProb = bay.overProb;
              let underProb = 100 - bay.overProb;
              if (bookLine && Math.abs(bookLine.line - bay.line) > 0) {
                // Recalculate Poisson prob at the book's line using adjusted prior
                overProb = +((1 - poissonCdfCalc(bookLine.line, bay.mean)) * 100).toFixed(1);
                underProb = +(100 - overProb).toFixed(1);
              }

              // Compare vs real book odds (with vig removed) or standard -115
              let bookOverImpl, bookUnderImpl, vigPct, bookSource;
              if (bookLine) {
                const vig = removeVig(bookLine.overOdds, bookLine.underOdds);
                bookOverImpl = vig.trueOverProb;
                bookUnderImpl = vig.trueUnderProb;
                vigPct = vig.vig;
                bookSource = bookLine.book;
              } else {
                bookOverImpl = 53.5;
                bookUnderImpl = 53.5;
                vigPct = 4.5;
                bookSource = 'Standard -115';
              }

              const overEdge = overProb - bookOverImpl;
              const underEdge = underProb - bookUnderImpl;

              const bestEdge = Math.max(overEdge, underEdge);
              const pick = overEdge > underEdge ? 'Over' : 'Under';
              const pickProb = pick === 'Over' ? overProb : underProb;
              const pickOdds = bookLine
                ? (pick === 'Over' ? bookLine.overOdds : bookLine.underOdds)
                : (pick === 'Over' ? bay.overOdds : bay.underOdds);

              if (bestEdge >= 3) {
                const variance = all.reduce((a, b) => a + (b - seasonMean) ** 2, 0) / (all.length - 1);
                const consistency = Math.sqrt(variance) / seasonMean;

                allEdges.push({
                  player: player.name, team: teamAbbr,
                  game: `${game.away.abbr} @ ${game.home.abbr}`,
                  gameDate: game.date,
                  stat: key, line, pick,
                  seasonMean: +seasonMean.toFixed(1),
                  playoffMean: poMean !== null ? +poMean.toFixed(1) : null,
                  playoffGames: poAll.length,
                  playoffBoost,
                  po2026Mean: po2026Mean !== null ? +po2026Mean.toFixed(1) : null,
                  l10Mean: +l10Mean.toFixed(1),
                  bayesianMean: bay.mean,
                  adjustedPrior: +priorMean.toFixed(1),
                  prob: +pickProb.toFixed(1),
                  odds: pickOdds,
                  edge: +bestEdge.toFixed(1),
                  consistency: +consistency.toFixed(2),
                  ci90: bay.ci90,
                  games: all.length,
                  bookSource: bookSource || null,
                  bookImpl: pick === 'Over' ? +bookOverImpl.toFixed(1) : +bookUnderImpl.toFixed(1),
                  vig: +vigPct,
                  hasRealOdds: !!bookLine,
                  trending: l10Mean > seasonMean ? 'hot' : l10Mean < seasonMean * 0.9 ? 'cold' : 'stable',
                  confidence: bestEdge >= 8 ? 'high' : bestEdge >= 5 ? 'medium' : 'low'
                });
              }
            }
          }
        } catch {}
      }
    }

    // Sort by edge, filter for quality
    allEdges.sort((a, b) => b.edge - a.edge);

    // Build parlays — diversify by game and player
    const buildParlay = (edges, legs = 4, label = '') => {
      const used = new Set(); // track used players
      const usedGames = new Set();
      const selected = [];

      for (const e of edges) {
        if (selected.length >= legs) break;
        if (used.has(e.player)) continue;
        // Allow max 2 from same game for correlation
        const gameCount = [...usedGames].filter(g => g === e.game).length;
        if (gameCount >= 2) continue;

        selected.push(e);
        used.add(e.player);
        usedGames.add(e.game);
      }

      if (selected.length < 2) return null;

      // Calculate parlay odds
      let decimalOdds = 1;
      let combinedProb = 1;
      for (const leg of selected) {
        const dec = leg.odds > 0 ? (leg.odds / 100) + 1 : (100 / Math.abs(leg.odds)) + 1;
        decimalOdds *= dec;
        combinedProb *= leg.prob / 100;
      }
      const americanOdds = decimalOdds >= 2 ? Math.round((decimalOdds - 1) * 100) : Math.round(-100 / (decimalOdds - 1));
      const avgEdge = selected.reduce((a, b) => a + b.edge, 0) / selected.length;

      return {
        label: label || `${selected.length}-Leg Value Parlay`,
        legs: selected,
        parlayOdds: americanOdds,
        decimalOdds: +decimalOdds.toFixed(2),
        combinedProb: +(combinedProb * 100).toFixed(2),
        avgEdge: +avgEdge.toFixed(1),
        ev: +((combinedProb * decimalOdds - 1) * 100).toFixed(1)
      };
    };

    // 3 different parlays with different strategies
    const picks = [];

    // 1. Highest edge parlay (best value)
    const highEdge = buildParlay(allEdges, 4, 'Best Edge Parlay');
    if (highEdge) picks.push(highEdge);

    // 2. Hot players parlay (trending up)
    const hotPlayers = allEdges.filter(e => e.trending === 'hot');
    const hotParlay = buildParlay(hotPlayers, 3, 'Hot Streak Parlay');
    if (hotParlay) picks.push(hotParlay);

    // 3. High consistency + edge (safe picks)
    const consistent = allEdges.filter(e => e.consistency < 0.35 && e.edge >= 4);
    const safeParlay = buildParlay(consistent, 3, 'Consistent Value Parlay');
    if (safeParlay) picks.push(safeParlay);

    // 4. High confidence only
    const highConf = allEdges.filter(e => e.confidence === 'high');
    const confParlay = buildParlay(highConf, 3, 'High Confidence Parlay');
    if (confParlay) picks.push(confParlay);

    const result = {
      date: new Date().toISOString().slice(0, 10),
      gamesAnalyzed: Math.min(games.length, 8),
      edgesFound: allEdges.length,
      topEdges: allEdges.slice(0, 15),
      picks: picks.filter(Boolean),
      hasBookData,
      methodology: hasBookData
        ? 'Playoff-adjusted Bayesian model (L10 recent + season/playoff blended prior) vs real sportsbook lines (vig removed). Only players with published book lines analyzed. Edge = model prob minus true market-implied prob.'
        : 'Playoff-adjusted Bayesian model (L10 recent + season/playoff blended prior) vs -115 standard. Set ODDS_API_KEY for real book line comparison.'
    };

    // Auto-submit picks as HxM system account slips (once per day)
    const slipCk = 'hxm-slips-posted-' + new Date().toISOString().slice(0, 10);
    if (!cache.get(slipCk) && picks.filter(Boolean).length > 0) {
      try {
        // Ensure HxM system account exists
        let hxmUser = await store.getUser('hxm');
        if (!hxmUser) {
          await store.createUser('hxm', 'HxMSystem2026!');
          hxmUser = await store.getUser('hxm');
        }

        // Submit each parlay as a slip
        for (const parlay of picks.filter(Boolean)) {
          const slipLegs = parlay.legs.map(l => ({
            type: 'prop',
            game: l.game,
            player: l.player,
            stat: l.stat,
            line: l.line,
            pick: `${l.pick} ${l.line}`,
            odds: l.odds
          }));

          const slipResult = await store.createSlip({
            user: 'hxm',
            legs: slipLegs,
            wager: 50, // $50 per parlay
            gameDate: parlay.legs[0]?.gameDate || null
          });

          if (slipResult.slip) {
            broadcast({ type: 'new_slip', slip: slipResult.slip });
            console.log(`[HxM] Auto-posted: ${parlay.label} (${slipLegs.length} legs, ${parlay.parlayOdds})`);
          }
        }
        cache.set(slipCk, true, 24 * 60 * 60_000); // flag: don't re-post today
      } catch (e) {
        console.error('[HxM] Failed to post slips:', e.message);
      }
    }

    cache.set(ck, result, 30 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === MODEL UTILITIES ===

// Poisson CDF (shared)
function poissonCdfCalc(k, lam) {
  let sum = 0;
  for (let i = 0; i <= Math.floor(k); i++) {
    let term = Math.exp(-lam);
    for (let j = 1; j <= i; j++) term *= lam / j;
    sum += term;
  }
  return Math.min(sum, 1);
}

// Bayesian conjugate model for player props
// Uses Normal-Normal conjugate prior: prior N(mu0, sigma0^2), data N(mean, sigma^2/n)
// Posterior: N(mu_post, sigma_post^2)
function bayesianUpdate(values, priorMean = null, priorWeight = 5) {
  if (!values.length) return null;
  const n = values.length;
  const dataMean = values.reduce((a, b) => a + b, 0) / n;
  const dataVar = n > 1 ? values.reduce((a, b) => a + (b - dataMean) ** 2, 0) / (n - 1) : dataMean;
  const dataSigma = Math.sqrt(dataVar);

  // Prior: use overall mean if not provided, with priorWeight pseudo-observations
  const mu0 = priorMean !== null ? priorMean : dataMean;
  const sigma0 = dataSigma; // prior uncertainty = data uncertainty

  // Posterior parameters (Normal-Normal conjugate)
  const priorPrec = priorWeight / (sigma0 * sigma0 + 0.01);
  const dataPrec = n / (dataVar + 0.01);
  const postPrec = priorPrec + dataPrec;
  const postMean = (priorPrec * mu0 + dataPrec * dataMean) / postPrec;
  const postVar = 1 / postPrec;
  const postSigma = Math.sqrt(postVar);

  // 90% credible interval
  const ci90Low = postMean - 1.645 * postSigma;
  const ci90High = postMean + 1.645 * postSigma;

  // Poisson line from posterior mean
  const line = Math.floor(postMean) + 0.5;
  const overProb = 1 - poissonCdfCalc(line, postMean);
  const toAm = (p) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);

  return {
    mean: +postMean.toFixed(1), sigma: +postSigma.toFixed(2),
    ci90: [+ci90Low.toFixed(1), +ci90High.toFixed(1)],
    line, games: n, priorMean: +mu0.toFixed(1),
    overProb: +(overProb * 100).toFixed(1),
    overOdds: toAm(overProb), underOdds: toAm(1 - overProb),
    shrinkage: +((1 - dataPrec / postPrec) * 100).toFixed(1) // how much prior pulls the estimate
  };
}

// Market-implied: remove vig from book odds to get true probability
function removeVig(overOdds, underOdds) {
  const implOver = overOdds < 0 ? Math.abs(overOdds) / (Math.abs(overOdds) + 100) : 100 / (overOdds + 100);
  const implUnder = underOdds < 0 ? Math.abs(underOdds) / (Math.abs(underOdds) + 100) : 100 / (underOdds + 100);
  const totalImpl = implOver + implUnder; // > 1.0 due to vig
  const vig = +((totalImpl - 1) * 100).toFixed(2);
  // Remove vig proportionally
  const trueOver = implOver / totalImpl;
  const trueUnder = implUnder / totalImpl;
  const toAm = (p) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
  return {
    rawOverImpl: +(implOver * 100).toFixed(1),
    rawUnderImpl: +(implUnder * 100).toFixed(1),
    vig,
    trueOverProb: +(trueOver * 100).toFixed(1),
    trueUnderProb: +(trueUnder * 100).toFixed(1),
    fairOverOdds: toAm(trueOver),
    fairUnderOdds: toAm(trueUnder)
  };
}

// API: Multi-model comparison for a game
// Returns Poisson, Bayesian, and Market-Implied lines for each player
app.get('/api/models/game/:gameIndex', async (req, res) => {
  const ck = `models-game-${req.params.gameIndex}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    // Get game from sweep or schedule
    const sweepCache = getCache();
    let game = sweepCache?.games?.[parseInt(req.params.gameIndex)];
    if (!game) {
      const today = new Date(); const end = new Date(today); end.setDate(end.getDate() + 7);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const sr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(today)}-${fmt(end)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const sd = await sr.json();
      const sched = (sd.events || []).map(ev => {
        const comp = ev.competitions?.[0]; const ts = comp?.competitors || [];
        const home = ts.find(t => t.homeAway === 'home'); const away = ts.find(t => t.homeAway === 'away');
        return { id: ev.id, date: ev.date, home: { name: home?.team?.displayName||'',abbr:home?.team?.abbreviation||'' }, away: { name: away?.team?.displayName||'',abbr:away?.team?.abbreviation||'' } };
      });
      game = sched[parseInt(req.params.gameIndex)];
    }
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const teams = sweepCache?.teams || await espn.getTeams();
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    // Try to get real book odds for market-implied
    let bookOddsMap = {};
    if (odds.isConfigured()) {
      try {
        const events = await odds.getEvents();
        const matchEvent = events.data?.find(e => {
          const h = e.home_team?.toLowerCase(); const gh = game.home.name.toLowerCase();
          return h?.includes(gh.split(' ').pop()) || gh.includes(h?.split(' ').pop());
        });
        if (matchEvent) {
          const propsResult = await odds.getPlayerProps(matchEvent.id);
          if (propsResult.data) {
            for (const p of propsResult.data) {
              bookOddsMap[p.name.toLowerCase()] = {};
              for (const l of p.lines) {
                bookOddsMap[p.name.toLowerCase()][l.stat] = {
                  line: l.line, overOdds: l.bestOver?.odds || l.over?.odds, underOdds: l.bestUnder?.odds || l.under?.odds,
                  book: l.bestOver?.book || l.over?.book || 'Best'
                };
              }
            }
          }
        }
      } catch {}
    }

    const analyzeTeam = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const roster = await espn.getPlayerStats(teamId);
      const top = roster.slice(0, 10);
      const gamelogs = await Promise.allSettled(top.map(p => espn.getPlayerGamelog(p.id)));
      const players = [];

      for (let i = 0; i < top.length; i++) {
        const player = top[i];
        const gl = gamelogs[i].status === 'fulfilled' ? gamelogs[i].value : null;
        if (!gl?.games?.length || gl.games.length < 5) continue;

        const statKeys = ['PTS', 'REB', 'AST', '3PM', 'FGM', 'FTM', 'STL', 'BLK'];
        const models = {};

        for (const key of statKeys) {
          const all = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
          if (all.length < 5) continue;
          const mean = all.reduce((a, b) => a + b, 0) / all.length;
          if (mean < 0.5) continue;

          const last10 = all.slice(0, Math.min(10, all.length));

          // 1. Poisson (season)
          const poissonLine = Math.floor(mean) + 0.5;
          const poissonOver = 1 - poissonCdfCalc(poissonLine, mean);
          const toAm = (p) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);

          // 2. Bayesian (L10 data, season prior)
          const bayesian = bayesianUpdate(last10, mean, 5);

          // 3. Market-Implied (if book odds available)
          const bookKey = player.name.toLowerCase();
          const statMap = { 'PTS': 'PTS', 'REB': 'REB', 'AST': 'AST', '3PM': '3PM', 'STL': 'STL', 'BLK': 'BLK' };
          const bookLine = bookOddsMap[bookKey]?.[statMap[key] || key];
          const market = bookLine && bookLine.overOdds && bookLine.underOdds
            ? removeVig(bookLine.overOdds, bookLine.underOdds)
            : null;

          models[key] = {
            poisson: {
              mean: +mean.toFixed(1), line: poissonLine, games: all.length,
              overProb: +(poissonOver * 100).toFixed(1),
              overOdds: toAm(poissonOver), underOdds: toAm(1 - poissonOver)
            },
            bayesian,
            market: market ? {
              ...market,
              line: bookLine.line, book: bookLine.book,
              bookOverOdds: bookLine.overOdds, bookUnderOdds: bookLine.underOdds
            } : null,
            // Edge: Bayesian vs Market
            edge: market && bayesian ? {
              overEdge: +(bayesian.overProb - market.trueOverProb).toFixed(1),
              underEdge: +((100 - bayesian.overProb) - market.trueUnderProb).toFixed(1)
            } : null
          };
        }

        if (Object.keys(models).length) {
          players.push({ name: player.name, id: player.id, team: teamAbbr, headshot: player.headshot, position: player.position, models });
        }
      }
      return players;
    };

    const [homePlayers, awayPlayers] = await Promise.all([
      analyzeTeam(homeTeam?.id, game.home.abbr),
      analyzeTeam(awayTeam?.id, game.away.abbr)
    ]);

    const result = {
      game: { home: game.home, away: game.away, date: game.date },
      players: [...awayPlayers, ...homePlayers],
      hasMarketData: Object.keys(bookOddsMap).length > 0
    };

    cache.set(ck, result, 15 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// source: 'today' (sweep) or 'sched' (schedule)
// ?windows=5,10,20 for custom windows (default: 10,20,season)
app.get('/api/book/auto-lines/:source/:gameIndex', async (req, res) => {
  const { source, gameIndex } = req.params;
  const windowsParam = req.query.windows || '10,20,season';
  const ck = `auto-lines-${source}-${gameIndex}-${windowsParam}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    let game;
    if (source === 'sched') {
      // Fetch schedule from ESPN
      const today = new Date();
      const end = new Date(today); end.setDate(end.getDate() + 7);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const sr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(today)}-${fmt(end)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const sd = await sr.json();
      const ev = (sd.events || [])[parseInt(gameIndex)];
      if (!ev) return res.status(404).json({ error: 'Scheduled game not found' });
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(t => t.homeAway === 'home');
      const away = comp?.competitors?.find(t => t.homeAway === 'away');
      game = {
        home: { name: home?.team?.displayName || 'TBD', abbr: home?.team?.abbreviation || 'TBD', logo: home?.team?.logo || '' },
        away: { name: away?.team?.displayName || 'TBD', abbr: away?.team?.abbreviation || 'TBD', logo: away?.team?.logo || '' },
        date: ev.date
      };
    } else {
      const sweepData = getCache() || await runSweep();
      game = sweepData?.games?.[parseInt(gameIndex)];
    }
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.home.abbr === 'TBD' || game.away.abbr === 'TBD') return res.status(400).json({ error: 'TBD matchup' });

    // Parse window sizes — supports: season, playoffs, PL10 (playoff last N), 10 (regular L10)
    const windowDefs = windowsParam.split(',').map(w => {
      const trimmed = w.trim();
      const lower = trimmed.toLowerCase();
      if (lower === 'season') return { key: 'season', size: null, type: 'regular' };
      if (lower === 'playoffs' || lower === 'playoffscareer') return { key: 'playoffs', size: null, type: 'playoff' };
      if (lower === 'playoffs2026') return { key: 'playoffs2026', size: null, type: 'playoff' };
      if (lower.startsWith('pl')) {
        const n = parseInt(lower.slice(2));
        return n > 0 ? { key: `PL${n}`, size: n, type: 'playoff' } : null;
      }
      const n = parseInt(trimmed);
      return n > 0 ? { key: `L${n}`, size: n, type: 'regular' } : null;
    }).filter(Boolean);

    const allTeams = await espn.getTeams();
    const homeTeam = allTeams.find(t => t.abbr === game.home.abbr);
    const awayTeam = allTeams.find(t => t.abbr === game.away.abbr);

    const needsPlayoffs = windowDefs.some(w => w.type === 'playoff');

    const buildLines = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const roster = await espn.getPlayerStats(teamId);
      const top = roster.slice(0, 12);
      const gamelogs = await Promise.allSettled(top.map(p => espn.getPlayerGamelog(p.id)));
      const playoffData = needsPlayoffs ? await Promise.allSettled(top.map(p => espn.getPlayerPlayoffStats(p.id))) : null;

      const results = [];
      for (let pi = 0; pi < top.length; pi++) {
        const player = top[pi];
        const gl = gamelogs[pi].status === 'fulfilled' ? gamelogs[pi].value : null;
        const po = playoffData?.[pi]?.status === 'fulfilled' ? playoffData[pi].value : null;
        if (!gl?.games?.length || gl.games.length < 5) continue;

        const statKeys = ['PTS', 'REB', 'AST', '3PM', 'FGM', 'FTM', 'STL', 'BLK'];
        for (const key of statKeys) {
          const allVals = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
          if (allVals.length < 5) continue;

          const compute = (vals) => {
            const n = vals.length;
            const mean = vals.reduce((a, b) => a + b, 0) / n;
            if (mean < 0.3) return null;
            const variance = n > 1 ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
            const line = Math.floor(mean) + 0.5;
            const poissonOver = 1 - poissonCdfCalc(line, mean);
            const toAm = (p) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
            return { mean: +mean.toFixed(1), stdDev: +Math.sqrt(variance).toFixed(1), line, games: n, overProb: +(poissonOver * 100).toFixed(1), overOdds: toAm(poissonOver), underOdds: toAm(1 - poissonOver) };
          };

          const models = {};
          for (const w of windowDefs) {
            if (w.key === 'season') {
              models.season = compute(allVals);
            } else if (w.key === 'playoffs') {
              const poVals = (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              if (poVals.length >= 3) models.playoffs = compute(poVals);
            } else if (w.key === 'playoffs2026') {
              const poVals26 = (po?.games || []).filter(g => g.season === 2026).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              if (poVals26.length >= 2) models.playoffs2026 = compute(poVals26);
            } else if (w.type === 'playoff' && w.size) {
              // PL10, PL20 etc — playoff last N
              const poVals = (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              if (poVals.length >= 2) models[w.key] = compute(poVals.slice(0, Math.min(w.size, poVals.length)));
            } else if (w.size && allVals.length >= Math.min(w.size, 3)) {
              models[w.key] = compute(allVals.slice(0, Math.min(w.size, allVals.length)));
            }
          }

          if (Object.values(models).some(m => m)) {
            results.push({
              player: player.name, playerId: player.id, team: teamAbbr,
              position: player.position, headshot: player.headshot, stat: key,
              models
            });
          }
        }
      }
      return results;
    };

    const [homeLines, awayLines] = await Promise.all([
      buildLines(homeTeam?.id, game.home.abbr),
      buildLines(awayTeam?.id, game.away.abbr)
    ]);

    const result = {
      game: { home: game.home, away: game.away, date: game.date },
      windows: windowDefs.map(w => w.key),
      lines: [...awayLines, ...homeLines]
    };

    cache.set(ck, result, 10 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat — old auto-lines route
app.get('/api/book/auto-lines/:gameIndex', async (req, res) => {
  // Redirect to new route with today source
  req.params.source = 'today';
  const handler = app._router.stack.find(r => r.route?.path === '/api/book/auto-lines/:source/:gameIndex');
  if (handler) return handler.route.stack[0].handle(req, res);
  res.redirect(`/api/book/auto-lines/today/${req.params.gameIndex}?windows=${req.query.windows || '10,20,season'}`);
});

// poissonCdfCalc defined in MODEL UTILITIES section above

// API: Player gamelog + statistical analysis (cached 1hr)
app.get('/api/players/:id/gamelog', async (req, res) => {
  const cacheKey = `gamelog-${req.params.id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const gamelog = await espn.getPlayerGamelog(req.params.id);
    if (!gamelog) return res.json({ error: 'No gamelog data' });

    // Compute statistical distributions for key stat columns
    const statKeys = ['MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FGM', 'FGA', '3PM', '3PA', 'FTM', 'FTA'];

    // Helper: extract made/attempted from "7-15" format
    const parseMadeAtt = (val) => {
      if (!val || typeof val !== 'string') return { made: 0, att: 0 };
      const parts = val.split('-');
      return { made: parseInt(parts[0]) || 0, att: parseInt(parts[1]) || 0 };
    };

    // Map stat keys to how to extract them from gamelog
    const extractStat = (stats, key) => {
      // Direct keys
      if (stats[`_${key}`] !== undefined && typeof stats[`_${key}`] !== 'string') return parseFloat(stats[`_${key}`]);
      if (stats[key] !== undefined && typeof stats[key] !== 'string') return parseFloat(stats[key]);
      // Parse from combined format
      if (key === 'FGM') return parseMadeAtt(stats['_FG'] || stats['fieldGoalsMade-fieldGoalsAttempted']).made;
      if (key === 'FGA') return parseMadeAtt(stats['_FG'] || stats['fieldGoalsMade-fieldGoalsAttempted']).att;
      if (key === '3PM') return parseMadeAtt(stats['_3PT'] || stats['threePointFieldGoalsMade-threePointFieldGoalsAttempted']).made;
      if (key === '3PA') return parseMadeAtt(stats['_3PT'] || stats['threePointFieldGoalsMade-threePointFieldGoalsAttempted']).att;
      if (key === 'FTM') return parseMadeAtt(stats['_FT'] || stats['freeThrowsMade-freeThrowsAttempted']).made;
      if (key === 'FTA') return parseMadeAtt(stats['_FT'] || stats['freeThrowsMade-freeThrowsAttempted']).att;
      // Fallback
      return parseFloat(stats[`_${key}`] || stats[key] || '0');
    };

    const distributions = {};

    for (const key of statKeys) {
      const values = gamelog.games
        .map(g => extractStat(g.stats, key))
        .filter(v => !isNaN(v));

      if (values.length < 3) continue;

      const n = values.length;
      const mean = values.reduce((a, b) => a + b, 0) / n;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
      const stdDev = Math.sqrt(variance);
      const sorted = [...values].sort((a, b) => a - b);
      const median = n % 2 === 0
        ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        : sorted[Math.floor(n / 2)];
      const min = sorted[0];
      const max = sorted[n - 1];
      const q1 = sorted[Math.floor(n * 0.25)];
      const q3 = sorted[Math.floor(n * 0.75)];
      const iqr = q3 - q1;

      // Skewness
      const skewness = n > 2
        ? (n / ((n - 1) * (n - 2))) * values.reduce((a, b) => a + ((b - mean) / stdDev) ** 3, 0)
        : 0;

      // Kurtosis (excess)
      const kurtosis = n > 3
        ? ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) *
          values.reduce((a, b) => a + ((b - mean) / stdDev) ** 4, 0) -
          (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
        : 0;

      // Distribution shape
      let shape = 'Normal';
      if (Math.abs(skewness) > 1) shape = skewness > 0 ? 'Right-skewed' : 'Left-skewed';
      else if (Math.abs(skewness) > 0.5) shape = skewness > 0 ? 'Slightly right-skewed' : 'Slightly left-skewed';
      if (kurtosis > 1) shape += ', heavy-tailed';
      else if (kurtosis < -1) shape += ', light-tailed';

      // Histogram bins — use integer bins for counting stats
      const intMin = Math.floor(min);
      const intMax = Math.ceil(max);
      const range = intMax - intMin;
      // For stats with small range (0-5), use 1-wide bins. Otherwise group.
      const binWidth = range <= 10 ? 1 : range <= 20 ? 2 : Math.ceil(range / 10);
      const binCount = Math.min(Math.ceil(range / binWidth) || 1, 15);
      const bins = Array(binCount).fill(0);
      const binEdges = [];
      for (let i = 0; i <= binCount; i++) binEdges.push(intMin + i * binWidth);
      for (const v of values) {
        const idx = Math.min(Math.floor((v - intMin) / binWidth), binCount - 1);
        bins[idx]++;
      }

      // Consistency score (lower CV = more consistent)
      const cv = mean !== 0 ? (stdDev / mean) * 100 : 0;
      let consistency = 'High';
      if (cv > 50) consistency = 'Very Low';
      else if (cv > 35) consistency = 'Low';
      else if (cv > 20) consistency = 'Medium';

      // Recent trend (last 10 vs season avg)
      const recent = values.slice(-10);
      const recentMean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : mean;
      const trend = recentMean - mean;
      const trendPct = mean !== 0 ? (trend / mean * 100) : 0;

      // Over/under analysis at common lines
      // Generate O/U lines at standard half-integers around the mean
      const baseLine = Math.floor(mean) + 0.5; // e.g. mean=7.1 → 7.5, mean=3.75 → 3.5
      const lines = [
        baseLine - 2, baseLine - 1, baseLine, baseLine + 1, baseLine + 2
      ].filter(l => l >= 0.5);
      const overUnder = lines.map(line => ({
        line: +line.toFixed(1),
        over: values.filter(v => v > line).length,
        under: values.filter(v => v <= line).length,
        overPct: +(values.filter(v => v > line).length / n * 100).toFixed(1)
      }));

      // Poisson analysis — NBA counting stats are naturally Poisson-distributed
      // Lambda (rate parameter) = mean for Poisson
      const lambda = mean;
      // Poisson P(X=k) = (e^-λ * λ^k) / k!
      const factorial = (n) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
      const poissonPmf = (k, lam) => Math.exp(-lam) * Math.pow(lam, k) / factorial(Math.min(k, 170));
      // Poisson CDF P(X <= k)
      const poissonCdf = (k, lam) => {
        let sum = 0;
        for (let i = 0; i <= Math.floor(k); i++) sum += poissonPmf(i, lam);
        return Math.min(sum, 1);
      };

      // Dispersion test: variance/mean ratio (should be ~1 for Poisson)
      const dispersionIndex = mean > 0 ? variance / mean : 0;
      // Chi-squared test for Poisson goodness of fit
      const isCountData = Number.isInteger(min) && min >= 0;
      let poissonFit = 'N/A';
      let poissonPvalue = null;
      if (isCountData && mean > 0) {
        // Compare observed vs expected frequencies
        const maxK = Math.min(Math.ceil(mean + 4 * stdDev), 60);
        let chiSq = 0;
        let dfCount = 0;
        for (let k = 0; k <= maxK; k++) {
          const observed = values.filter(v => Math.round(v) === k).length;
          const expected = n * poissonPmf(k, lambda);
          if (expected >= 1) {
            chiSq += (observed - expected) ** 2 / expected;
            dfCount++;
          }
        }
        // Rough p-value using chi-squared approximation
        const df = Math.max(dfCount - 2, 1);
        // If chi-sq/df < 2, decent fit
        const ratio = chiSq / df;
        if (ratio < 1.5) poissonFit = 'Excellent';
        else if (ratio < 2.5) poissonFit = 'Good';
        else if (ratio < 4) poissonFit = 'Fair';
        else poissonFit = 'Poor';
      }

      // Poisson probabilities at standard half-integer lines (0.5, 1.5, 2.5...)
      const poissonOU = [];
      if (isCountData && mean > 0) {
        const base = Math.floor(mean) + 0.5;
        const checkLines = [
          base - 2, base - 1, base, base + 1, base + 2
        ].filter(l => l >= 0.5);
        const uniqueLines = [...new Set(checkLines)].sort((a, b) => a - b);
        for (const line of uniqueLines) {
          const overProb = +(1 - poissonCdf(line, lambda)).toFixed(4);
          const underProb = +poissonCdf(line, lambda).toFixed(4);
          // Convert probability to American odds
          const overOdds = overProb >= 0.5
            ? Math.round(-100 * overProb / (1 - overProb))
            : Math.round(100 * (1 - overProb) / overProb);
          const underOdds = underProb >= 0.5
            ? Math.round(-100 * underProb / (1 - underProb))
            : Math.round(100 * (1 - underProb) / underProb);
          poissonOU.push({
            line,
            overProb: +(overProb * 100).toFixed(1),
            underProb: +(underProb * 100).toFixed(1),
            overOdds: overOdds > 0 ? `+${overOdds}` : `${overOdds}`,
            underOdds: underOdds > 0 ? `+${underOdds}` : `${underOdds}`,
            exactProb: +(poissonPmf(Math.round(line), lambda) * 100).toFixed(1)
          });
        }
      }

      distributions[key] = {
        n,
        mean: +mean.toFixed(2),
        median: +median.toFixed(1),
        stdDev: +stdDev.toFixed(2),
        variance: +variance.toFixed(2),
        min, max,
        q1, q3, iqr: +iqr.toFixed(1),
        skewness: +skewness.toFixed(3),
        kurtosis: +kurtosis.toFixed(3),
        shape,
        cv: +cv.toFixed(1),
        consistency,
        histogram: { bins, binEdges },
        recentMean: +recentMean.toFixed(2),
        trend: +trend.toFixed(2),
        trendPct: +trendPct.toFixed(1),
        overUnder,
        values: sorted,
        // Poisson
        poisson: {
          lambda: +lambda.toFixed(2),
          dispersionIndex: +dispersionIndex.toFixed(3),
          isOverdispersed: dispersionIndex > 1.5,
          isUnderdispersed: dispersionIndex < 0.7,
          fit: poissonFit,
          isCountData,
          overUnder: poissonOU
        }
      };
    }

    const result = { gamelog, distributions };
    cache.set(cacheKey, result, TTL.PLAYER_GAMELOG);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Polymarket championship odds (cached 10min)
app.get('/api/polymarket/champion', async (req, res) => {
  const cached = cache.get('poly-champion');
  if (cached) return res.json(cached);
  const data = await polymarket.getChampionshipOdds();
  cache.set('poly-champion', data, 10 * 60_000);
  res.json(data);
});

// API: All Polymarket NBA events (cached 10min)
app.get('/api/polymarket/events', async (req, res) => {
  const cached = cache.get('poly-events');
  if (cached) return res.json(cached);
  const data = await polymarket.getNBAEvents();
  cache.set('poly-events', data, 10 * 60_000);
  res.json(data);
});

// === In-House Bookmaker ===
// Custom lines created by users — others can bet against them

app.post('/api/book/lines', authMiddleware, async (req, res) => {
  const { player, stat, line, overOdds, underOdds, game, gameDate, maxWager } = req.body;
  if (!player || !stat || line == null) return res.status(400).json({ error: 'player, stat, line required' });
  const entry = {
    id: (await import('crypto')).randomUUID().slice(0, 8),
    maker: req.user.name,
    makerDisplay: req.user.displayName,
    player, stat, line: parseFloat(line),
    overOdds: parseInt(overOdds) || -110,
    underOdds: parseInt(underOdds) || -110,
    game: game || '',
    gameDate: gameDate || null,
    maxWager: parseFloat(maxWager) || 500,
    createdAt: new Date().toISOString(),
    bets: [],
    status: 'open'
  };
  await backend_lpush_book(entry);
  broadcast({ type: 'new_line', line: entry });
  res.json({ line: entry });
});

app.get('/api/book/lines', async (req, res) => {
  const lines = await backend_lrange_book();
  const open = lines.filter(l => l.status === 'open');
  res.json(open);
});

app.post('/api/book/bet', authMiddleware, async (req, res) => {
  const { lineId, side, wager } = req.body;
  if (!lineId || !side || !wager) return res.status(400).json({ error: 'lineId, side (over/under), wager required' });

  const lines = await backend_lrange_book();
  const idx = lines.findIndex(l => l.id === lineId);
  if (idx === -1) return res.status(404).json({ error: 'Line not found' });
  const line = lines[idx];
  if (line.status !== 'open') return res.status(400).json({ error: 'Line is closed' });
  if (line.maker === req.user.name) return res.status(400).json({ error: 'Cannot bet your own line' });

  const totalBet = line.bets.reduce((a, b) => a + b.wager, 0);
  if (totalBet + parseFloat(wager) > line.maxWager) return res.status(400).json({ error: `Max wager exceeded (${line.maxWager - totalBet} remaining)` });

  const odds = side === 'over' ? line.overOdds : line.underOdds;
  const dec = odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;

  line.bets.push({
    user: req.user.name,
    userDisplay: req.user.displayName,
    side,
    wager: parseFloat(wager),
    odds,
    payout: +(parseFloat(wager) * dec).toFixed(2),
    createdAt: new Date().toISOString()
  });

  await backend_lset_book(idx, line);
  broadcast({ type: 'new_bet', lineId, bet: line.bets[line.bets.length - 1] });
  res.json({ line });
});

// Simple book storage helpers (uses same backend pattern)
async function backend_lpush_book(entry) {
  const all = await backend_lrange_book();
  all.unshift(entry);
  await save_book(all);
}
async function backend_lrange_book() {
  try {
    const raw = cache.get('book-lines-store');
    if (raw) return raw;
    // Try to load from file on local
    const { readFileSync, existsSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const f = join(process.env.DATA_DIR || join(__dirname, '..', 'data'), 'book.json');
    if (existsSync(f)) {
      const data = JSON.parse(readFileSync(f, 'utf-8'));
      cache.set('book-lines-store', data, 24 * 60 * 60_000);
      return data;
    }
  } catch {}
  return [];
}
async function backend_lset_book(idx, entry) {
  const all = await backend_lrange_book();
  all[idx] = entry;
  await save_book(all);
}
async function save_book(all) {
  cache.set('book-lines-store', all, 24 * 60 * 60_000);
  try {
    const { writeFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const f = join(process.env.DATA_DIR || join(__dirname, '..', 'data'), 'book.json');
    writeFileSync(f, JSON.stringify(all, null, 2));
  } catch {}
}

// === Soccer / Champions League API ===

app.get('/api/soccer/:league/scoreboard', async (req, res) => {
  const ck = `soccer-scores-${req.params.league}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  const data = await soccer.getScoreboard(req.params.league);
  cache.set(ck, data, 60_000);
  res.json(data);
});

app.get('/api/soccer/:league/standings', async (req, res) => {
  const ck = `soccer-standings-${req.params.league}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  const data = await soccer.getStandings(req.params.league);
  cache.set(ck, data, TTL.TEAM_DETAIL);
  res.json(data);
});

app.get('/api/soccer/:league/teams', async (req, res) => {
  const ck = `soccer-teams-${req.params.league}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  const data = await soccer.getTeams(req.params.league);
  cache.set(ck, data, TTL.TEAMS_LIST);
  res.json(data);
});

app.get('/api/soccer/:league/news', async (req, res) => {
  const ck = `soccer-news-${req.params.league}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  const data = await soccer.getNews(req.params.league);
  cache.set(ck, data, 5 * 60_000);
  res.json(data);
});

app.get('/api/soccer/:league/teams/:id', async (req, res) => {
  const ck = `soccer-team-${req.params.league}-${req.params.id}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  try {
    const [detail, roster] = await Promise.all([
      soccer.getTeamDetail(req.params.league, req.params.id),
      soccer.getTeamRoster(req.params.league, req.params.id)
    ]);
    const result = { detail, roster };
    cache.set(ck, result, TTL.TEAM_DETAIL);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Soccer player overview (proxied to avoid CORS)
app.get('/api/soccer/:league/players/:id', async (req, res) => {
  const ck = `soccer-player-${req.params.league}-${req.params.id}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  try {
    const data = await soccer.getPlayerOverview(req.params.league, req.params.id);
    if (data) cache.set(ck, data, TTL.PLAYER_STATS);
    res.json(data || { error: 'Player not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Soccer odds via The Odds API
app.get('/api/soccer/odds/:sport', async (req, res) => {
  const ck = `soccer-odds-${req.params.sport}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  if (!odds.isConfigured()) return res.json({ source: 'none', data: [] });
  try {
    const key = process.env.ODDS_API_KEY;
    const url = `https://api.the-odds-api.com/v4/sports/${req.params.sport}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return res.json({ source: 'none', data: [] });
    const data = await r.json();
    const result = { source: 'odds-api', data };
    cache.set(ck, result, TTL.GAME_ODDS);
    res.json(result);
  } catch {
    res.json({ source: 'none', data: [] });
  }
});

// Soccer props — real book lines from Odds API + model fallback
app.get('/api/soccer/:league/props/:gameIndex', async (req, res) => {
  const ck = `soccer-props-${req.params.league}-${req.params.gameIndex}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    // Always use 14-day schedule — slips + analysis pages index into this array
    const today = new Date();
    const end = new Date(today); end.setDate(end.getDate() + 14);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const schedUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${req.params.league}/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
    const schedRes = await fetch(schedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const schedData = await schedRes.json();
    const schedGames = (schedData.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const teams = comp?.competitors || [];
      const home = teams.find(t => t.homeAway === 'home');
      const away = teams.find(t => t.homeAway === 'away');
      return {
        id: ev.id, name: ev.name, date: ev.date,
        status: comp?.status?.type?.description || 'Unknown',
        home: { name: home?.team?.displayName || '', abbr: home?.team?.abbreviation || '', logo: home?.team?.logo || '' },
        away: { name: away?.team?.displayName || '', abbr: away?.team?.abbreviation || '', logo: away?.team?.logo || '' },
        odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0, provider: comp.odds[0].provider?.name || '' } : null
      };
    });
    const game = schedGames[parseInt(req.params.gameIndex)];

    if (!game) return res.status(404).json({ error: 'Game not found at index ' + req.params.gameIndex });

    const teams = await soccer.getTeams(req.params.league);
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    let realGameOdds = null;
    let realPlayerProps = null;
    let source = 'model';

    // Try Odds API for real lines
    const key = process.env.ODDS_API_KEY;
    if (key) {
      try {
        const leagueToOdds = {
          'uefa.champions': 'soccer_uefa_champs_league',
          'uefa.europa': 'soccer_uefa_europa_league',
          'eng.1': 'soccer_epl',
          'esp.1': 'soccer_spain_la_liga'
        };
        const sportKey = leagueToOdds[req.params.league] || 'soccer_epl';

        // Game odds (h2h, spreads, totals)
        const gameOddsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
        const goRes = await fetch(gameOddsUrl, { signal: AbortSignal.timeout(8000) });
        if (goRes.ok) {
          const goData = await goRes.json();
          // Match game
          const matched = goData.find(g => {
            const h = g.home_team?.toLowerCase();
            const a = g.away_team?.toLowerCase();
            return h?.includes(game.home.name.toLowerCase().split(' ').pop()) ||
                   game.home.name.toLowerCase().includes(h?.split(' ').pop());
          });
          if (matched?.bookmakers?.length) {
            realGameOdds = matched;
            source = 'odds-api';
          }

          // Player props
          if (matched) {
            const propMarkets = 'player_goal_scorer_anytime,player_shots,player_shots_on_target,player_assists';
            const ppUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${matched.id}/odds?apiKey=${key}&regions=us&markets=${propMarkets}&oddsFormat=american`;
            const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(8000) });
            if (ppRes.ok) {
              const ppData = await ppRes.json();
              const playerMap = {};
              for (const bk of ppData.bookmakers || []) {
                for (const mkt of bk.markets || []) {
                  const statMap = {
                    player_goal_scorer_anytime: 'Anytime Goal',
                    player_shots: 'Shots Attempted',
                    player_shots_on_target: 'Shots on Target',
                    player_assists: 'Assists'
                  };
                  const stat = statMap[mkt.key] || mkt.key;
                  for (const o of mkt.outcomes || []) {
                    const name = o.description || o.name;
                    if (!playerMap[name]) playerMap[name] = [];
                    playerMap[name].push({
                      stat, line: o.point || 0.5, overOdds: o.price, underOdds: null,
                      book: bk.title, side: o.name
                    });
                  }
                }
              }
              if (Object.keys(playerMap).length) {
                realPlayerProps = Object.entries(playerMap).map(([name, lines]) => {
                  // Deduplicate by stat — keep best odds
                  const byKey = {};
                  for (const l of lines) {
                    const k = `${l.stat}-${l.line}`;
                    if (!byKey[k] || l.overOdds > byKey[k].overOdds) byKey[k] = l;
                  }
                  return { name, source: 'odds-api', lines: Object.values(byKey) };
                });
              }
            }
          }
        }
      } catch (e) {
        console.error('[SOCCER-ODDS]', e.message);
      }
    }

    // Build game lines
    let gameLines = null;
    if (realGameOdds) {
      gameLines = {
        source: 'odds-api',
        books: realGameOdds.bookmakers.map(bk => {
          const markets = {};
          bk.markets.forEach(m => { markets[m.key] = m.outcomes; });
          return { name: bk.title, markets };
        })
      };
    } else if (game.odds) {
      gameLines = { source: 'espn', ...game.odds };
    }

    // Build player props — merge real + model
    let playerProps;
    if (realPlayerProps?.length) {
      // Start with real props, add model data for players not covered
      const [homeModelProps, awayModelProps] = await Promise.all([
        homeTeam ? soccer.getTeamProps(req.params.league, homeTeam.id) : [],
        awayTeam ? soccer.getTeamProps(req.params.league, awayTeam.id) : []
      ]);
      const modelProps = [
        ...awayModelProps.map(p => ({ ...p, team: game.away.abbr })),
        ...homeModelProps.map(p => ({ ...p, team: game.home.abbr }))
      ];

      // Merge: keep BOTH real book lines and model lines for comparison
      // Tag each line with source so frontend can distinguish
      const mergedByName = {};

      // Add real book lines (tagged)
      for (const p of realPlayerProps) {
        const key = p.name.toLowerCase();
        if (!mergedByName[key]) mergedByName[key] = { name: p.name, source: 'mixed', lines: [], position: p.position, team: p.team, headshot: p.headshot };
        for (const l of p.lines) {
          mergedByName[key].lines.push({ ...l, source: 'book', book: l.book || 'Sportsbook' });
        }
      }

      // Add model lines (tagged) — even for stats that books cover
      for (const mp of modelProps) {
        const key = mp.name.toLowerCase();
        if (!mergedByName[key]) mergedByName[key] = { name: mp.name, source: 'model', lines: [], position: mp.position, team: mp.team, headshot: mp.headshot };
        const p = mergedByName[key];
        if (!p.position && mp.position) p.position = mp.position;
        if (!p.team && mp.team) p.team = mp.team;
        if (!p.headshot && mp.headshot) p.headshot = mp.headshot;
        for (const line of mp.lines || []) {
          p.lines.push({ ...line, source: 'model', book: 'Poisson' });
        }
      }

      playerProps = Object.values(mergedByName);
    } else {
      const [homeProps, awayProps] = await Promise.all([
        homeTeam ? soccer.getTeamProps(req.params.league, homeTeam.id) : [],
        awayTeam ? soccer.getTeamProps(req.params.league, awayTeam.id) : []
      ]);
      playerProps = [
        ...awayProps.map(p => ({ ...p, team: game.away.abbr, source: 'model', lines: (p.lines || []).map(l => ({ ...l, source: 'model', book: l.book || 'Poisson' })) })),
        ...homeProps.map(p => ({ ...p, team: game.home.abbr, source: 'model', lines: (p.lines || []).map(l => ({ ...l, source: 'model', book: l.book || 'Poisson' })) }))
      ];
    }

    const result = {
      game: { home: game.home, away: game.away, date: game.date },
      source: realPlayerProps?.length ? 'odds-api' : 'model',
      gameLines,
      playerProps
    };

    cache.set(ck, result, TTL.PROPS_MERGED);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Polymarket CL
app.get('/api/polymarket/ucl', async (req, res) => {
  const ck = 'poly-ucl';
  const cached = cache.get(ck);
  if (cached) return res.json(cached);
  try {
    const { default: poly } = await import('./sources/polymarket.mjs');
    // Search for UCL event
    const r = await fetch('https://gamma-api.polymarket.com/events?slug_contains=champions-league&closed=false&limit=3', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const events = await r.json();
    const result = [];
    for (const e of events) {
      if (!e.title?.includes('Champion')) continue;
      const mkts = (e.markets || []).map(m => {
        const prices = JSON.parse(m.outcomePrices || '["0"]');
        const yes = parseFloat(prices[0]);
        if (yes < 0.005) return null;
        return { question: m.question, prob: +(yes * 100).toFixed(1), odds: yes > 0.5 ? Math.round(-100 * yes / (1 - yes)) : Math.round(100 * (1 - yes) / yes) };
      }).filter(Boolean).sort((a, b) => b.prob - a.prob);
      if (mkts.length) result.push({ title: e.title, volume: e.volume, markets: mkts.slice(0, 15) });
    }
    cache.set(ck, result, 10 * 60_000);
    res.json(result);
  } catch { res.json([]); }
});

// === Shared Resolver Engine ===
async function resolveEngine() {
  const activeSlips = await store.getSlips({ status: 'active', limit: 200 });
  if (!activeSlips.length) return { resolved: 0, total: 0, results: [], message: 'No active slips' };

  // Fetch finished games — NBA + Soccer
  const [nbaSchedRes, soccerSchedRes] = await Promise.allSettled([
    fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + getDateRange(), {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000)
    }).then(r => r.json()),
    fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=' + getDateRange(), {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000)
    }).then(r => r.json())
  ]);

  const nbaEvents = nbaSchedRes.status === 'fulfilled' ? nbaSchedRes.value.events || [] : [];
  const soccerEvents = soccerSchedRes.status === 'fulfilled' ? soccerSchedRes.value.events || [] : [];
  const finishedGames = [
    ...nbaEvents.filter(e => e.competitions?.[0]?.status?.type?.description === 'Final').map(e => ({ ...e, _sport: 'nba' })),
    ...soccerEvents.filter(e => ['Full Time','Final'].includes(e.competitions?.[0]?.status?.type?.description)).map(e => ({ ...e, _sport: 'soccer' }))
  ];

  const boxScores = {};
  const gameScores = {}; // {gameKey: {home:{abbr,score}, away:{abbr,score}}}

  for (const event of finishedGames) {
    try {
      // Get final scores from schedule data
      const comp = event.competitions?.[0];
      const teams = comp?.competitors || [];
      const awayTeam = teams.find(t => t.homeAway === 'away');
      const homeTeam = teams.find(t => t.homeAway === 'home');
      const away = awayTeam?.team?.abbreviation || '';
      const home = homeTeam?.team?.abbreviation || '';
      const awayScore = parseInt(awayTeam?.score || '0');
      const homeScore = parseInt(homeTeam?.score || '0');
      const awayName = awayTeam?.team?.displayName || '';
      const homeName = homeTeam?.team?.displayName || '';

      const scoreData = {
        home: { abbr: home, name: homeName, score: homeScore },
        away: { abbr: away, name: awayName, score: awayScore },
        total: homeScore + awayScore,
        winner: homeScore > awayScore ? home : away,
        winnerName: homeScore > awayScore ? homeName : awayName,
        margin: Math.abs(homeScore - awayScore)
      };

      // Fetch box score for player stats — different endpoint for NBA vs Soccer
      const sportPath = event._sport === 'soccer' ? 'soccer/uefa.champions' : 'basketball/nba';
      const bsRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${event.id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000)
      });
      const bsData = await bsRes.json();
      const players = {};

      if (event._sport === 'soccer') {
        // Soccer: stats are in rosters[].roster[].stats (array of stat objects)
        for (const team of bsData.rosters || []) {
          for (const p of team.roster || []) {
            const name = p.athlete?.displayName || '';
            const rawStats = p.stats || [];
            const stats = {};
            for (const s of rawStats) {
              stats[s.abbreviation || s.name] = parseFloat(s.value) || 0;
            }
            // Normalize to resolver keys
            stats._G = stats.G || 0;
            stats._A = stats.A || 0;
            stats._SH = stats.SH || 0;
            stats._ST = stats.ST || 0;
            stats._FC = stats.FC || 0;
            stats._FA = stats.FA || 0;
            stats._YC = stats.YC || 0;
            stats._RC = stats.RC || 0;
            stats._SV = stats.SV || 0;
            stats._GA = stats.GA || 0;
            stats._OF = stats.OF || 0;
            // Map soccer stat names to resolver stat names
            stats['Anytime Goal'] = stats._G;
            stats['Goals'] = stats._G;
            stats['Assists'] = stats._A;
            stats['Shots Attempted'] = stats._SH;
            stats['Shots on Target'] = stats._ST;
            stats['Fouls Committed'] = stats._FC;
            stats['Fouls Drawn'] = stats._FA;
            stats['Yellow Cards'] = stats._YC;
            stats['Goals + Assists'] = stats._G + stats._A;
            stats['Goal or Assist'] = (stats._G + stats._A) > 0 ? 1 : 0;
            stats['To Be Carded'] = stats._YC + stats._RC > 0 ? 1 : 0;
            stats['Saves'] = stats._SV;
            stats['Clean Sheet'] = stats._GA === 0 ? 1 : 0;
            players[name.toLowerCase()] = stats;
          }
        }
      } else {
        // NBA: stats are in boxscore.players[].statistics[].athletes[]
        for (const team of bsData.boxscore?.players || []) {
          for (const sg of team.statistics || []) {
            const labels = sg.labels || [];
            for (const a of sg.athletes || []) {
              const name = a.athlete?.displayName || '';
              const stats = {};
              labels.forEach((l, i) => { stats[l] = a.stats?.[i] || '0'; });
              const parseFG = (v) => { const p = (v || '0-0').split('-'); return { made: parseInt(p[0]) || 0, att: parseInt(p[1]) || 0 }; };
              stats._PTS = parseInt(stats.PTS || '0');
              stats._REB = parseInt(stats.REB || '0');
              stats._AST = parseInt(stats.AST || '0');
              stats._TO = parseInt(stats.TO || '0');
              stats._STL = parseInt(stats.STL || '0');
              stats._BLK = parseInt(stats.BLK || '0');
              stats._3PM = parseFG(stats['3PT']).made;
              stats._FGM = parseFG(stats.FG).made;
              stats._FGA = parseFG(stats.FG).att;
              stats._FTM = parseFG(stats.FT).made;
              stats._MIN = parseInt(stats.MIN || '0');
              stats._PRA = stats._PTS + stats._REB + stats._AST;
              const ddCats = [stats._PTS, stats._REB, stats._AST, stats._STL, stats._BLK].filter(v => v >= 10).length;
              stats._DD = ddCats >= 2;
              stats._TD = ddCats >= 3;
              players[name.toLowerCase()] = stats;
            }
          }
        }
      }

      // Store under many key variations
      const keys = [
        `${away} @ ${home}`, `${away} vs ${home}`, `${home} vs ${away}`,
        `${away}@${home}`, `${away}_${home}`, `${home}_${away}`
      ];
      for (const k of keys) {
        boxScores[k.toLowerCase()] = players;
        gameScores[k.toLowerCase()] = scoreData;
      }
      boxScores[event.id] = players;
      gameScores[event.id] = scoreData;
    } catch {}
  }

  if (!Object.keys(boxScores).length) return { resolved: 0, total: activeSlips.length, results: [], message: 'No finished games found' };

  const allBoxKeys = Object.keys(boxScores);

  function findGame(game, gameId) {
    if (gameId && gameId !== 'undefined') {
      if (boxScores[gameId]) return { players: boxScores[gameId], scores: gameScores[gameId] };
    }
    const g = (game || '').toLowerCase().replace(/\s+/g, ' ');
    const tryKeys = [g, g.replace(' vs ', ' @ '), g.replace(' @ ', ' vs ')];
    for (const k of tryKeys) {
      if (boxScores[k]) return { players: boxScores[k], scores: gameScores[k] };
    }
    // Fuzzy: match by team abbreviation fragments
    const parts = g.split(/\s+(?:@|vs|v)\s+/);
    if (parts.length === 2) {
      const a = parts[0].trim().split(' ').pop();
      const b = parts[1].trim().split(' ').pop();
      for (const k of allBoxKeys) {
        if (a && b && k.includes(a) && k.includes(b)) return { players: boxScores[k], scores: gameScores[k] };
      }
    }
    return null;
  }

  function findPlayer(players, name) {
    if (!players || !name) return null;
    const n = name.toLowerCase();
    if (players[n]) return players[n];
    const lastName = n.split(' ').pop();
    for (const [k, v] of Object.entries(players)) {
      if (k.includes(lastName) || (lastName.length > 3 && k.split(' ').pop() === lastName)) return v;
    }
    return null;
  }

  let resolved = 0;
  const results = [];

  for (const slip of activeSlips) {
    const legResults = [];
    let anyFromFinished = false;

    for (const leg of slip.legs) {
      const gameData = findGame(leg.game, leg.gameId);

      if (!gameData) { legResults.push('pending'); continue; }
      anyFromFinished = true;

      const { players, scores } = gameData;
      const pick = (leg.pick || '').toLowerCase();

      // === ML (Moneyline) ===
      if (leg.stat === 'ML') {
        if (!scores) { legResults.push('pending'); continue; }
        const pickedTeam = (leg.player || '').toLowerCase();
        const winner = (scores.winnerName || '').toLowerCase();
        const winnerAbbr = (scores.winner || '').toLowerCase();
        const won = winner.includes(pickedTeam.split(' ').pop()) || winnerAbbr === pickedTeam.split(' ').pop()?.toLowerCase() || pickedTeam.includes(winner.split(' ').pop());
        legResults.push(won ? 'won' : 'lost');
        continue;
      }

      // === SPREAD ===
      if (leg.stat === 'SPREAD') {
        if (!scores) { legResults.push('pending'); continue; }
        // Parse spread from pick like "Charlotte Hornets -6" or "CHA -5.5"
        const spreadMatch = pick.match(/([\w\s]+?)\s+([+-]?\d+\.?\d*)/);
        if (!spreadMatch) { legResults.push('pending'); continue; }
        const spreadTeam = spreadMatch[1].trim();
        const spreadVal = parseFloat(spreadMatch[2]);
        // Determine if the picked team is home or away
        const isHome = scores.home.name.toLowerCase().includes(spreadTeam.split(' ').pop()) || scores.home.abbr.toLowerCase() === spreadTeam.split(' ').pop();
        const teamScore = isHome ? scores.home.score : scores.away.score;
        const oppScore = isHome ? scores.away.score : scores.home.score;
        const adjustedMargin = teamScore + spreadVal - oppScore;
        legResults.push(adjustedMargin > 0 ? 'won' : adjustedMargin === 0 ? 'push' : 'lost');
        continue;
      }

      // === TOTAL (Over/Under) ===
      if (leg.stat === 'TOTAL') {
        if (!scores) { legResults.push('pending'); continue; }
        const line = parseFloat(leg.line) || 0;
        const total = scores.total;
        if (pick.includes('over')) {
          legResults.push(total > line ? 'won' : total === line ? 'push' : 'lost');
        } else {
          legResults.push(total < line ? 'won' : total === line ? 'push' : 'lost');
        }
        continue;
      }

      // === Player props ===
      const pStats = findPlayer(players, leg.player);
      if (!pStats) { legResults.push('lost'); continue; }

      // NBA stat key mapping
      const statMap = { 'PTS':'_PTS','REB':'_REB','AST':'_AST','TO':'_TO','STL':'_STL','BLK':'_BLK',
        '3PM':'_3PM','FGM':'_FGM','FGA':'_FGA','FTM':'_FTM','PRA':'_PRA','MIN':'_MIN' };

      let result = 'pending';
      if (leg.stat === 'Double-Double') {
        result = (pick.includes('over') || pick.includes('yes')) ? (pStats._DD ? 'won' : 'lost') : (!pStats._DD ? 'won' : 'lost');
      } else if (leg.stat === 'Triple-Double') {
        result = (pick.includes('over') || pick.includes('yes')) ? (pStats._TD ? 'won' : 'lost') : (!pStats._TD ? 'won' : 'lost');
      } else {
        // Try NBA stat map first, then direct stat name (soccer stores stats by prop name)
        const actual = statMap[leg.stat] ? pStats[statMap[leg.stat]] : (pStats[leg.stat] ?? null);
        if (actual !== null && actual !== undefined) {
          const line = parseFloat(leg.line) || 0;
          if (pick.includes('over') || pick.includes('yes')) {
            result = actual > line ? 'won' : actual === line ? 'push' : 'lost';
          } else {
            result = actual < line ? 'won' : actual === line ? 'push' : 'lost';
          }
        }
      }
      legResults.push(result);
    }

    const noPending = legResults.every(r => r !== 'pending');
    if (noPending && anyFromFinished) {
      const gradeResult = await store.gradeSlip(slip.id, legResults);
      if (!gradeResult.error) {
        resolved++;
        const s = gradeResult.slip;
        results.push({ id: slip.id, user: slip.user, result: s?.status, legs: legResults });
        console.log(`[RESOLVE] ${slip.id} ${slip.user} -> ${s?.status} (${legResults.join(',')})`);
        broadcast({ type: 'slip_graded', slip: s });
      }
    }
  }

  return { resolved, total: activeSlips.length, results };
}

// Slip resolver endpoint (auth required)
app.post('/api/slips/resolve', authMiddleware, async (req, res) => {
  try {
    const result = await resolveEngine();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

    // Get completed games from schedule
    const scheduleRes = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + getDateRange(), {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000)
    });

function getDateRange() {
  const d = new Date();
  const start = new Date(d); start.setDate(start.getDate() - 3);
  const end = new Date(d); end.setDate(end.getDate() + 1);
  const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
  return `${fmt(start)}-${fmt(end)}`;
}

// API: Get resolution status for a slip
app.get('/api/slips/:id/check', async (req, res) => {
  const slip = await store.getSlip(req.params.id);
  if (!slip) return res.status(404).json({ error: 'Not found' });
  res.json(slip);
});

// API: Cache stats
app.get('/api/cache', (req, res) => {
  res.json(cache.stats());
});

// API: Source status
app.get('/api/status', (req, res) => {
  const data = getCache();
  res.json({
    online: true,
    lastSweep: data?.timestamp || null,
    sweepMs: data?.sweepMs || 0,
    sources: data?.sources || {},
    gameCount: data?.games?.length || 0,
    injuryCount: data?.injuries?.length || 0
  });
});

// === Betting Slips API ===

// Auth middleware — checks token from Authorization header
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await store.verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// Sign up
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!password) return res.status(400).json({ error: 'Password required' });
  const result = await store.createUser(username, password);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const result = await store.loginUser(username, password);
  if (result.error) return res.status(401).json(result);
  res.json(result);
});

// Get current user from token
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// Get user (public profile)
app.get('/api/users/:name', async (req, res) => {
  const user = await store.getUser(req.params.name);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  res.json(await store.getLeaderboard());
});

// Create slip (requires auth)
app.post('/api/slips', authMiddleware, async (req, res) => {
  const { legs, wager, gameDate } = req.body;
  const result = await store.createSlip({ user: req.user.name, legs, wager, gameDate });
  if (result.error) return res.status(400).json(result);
  broadcast({ type: 'new_slip', slip: result.slip });
  res.json(result);
});

// Get all slips
app.get('/api/slips', async (req, res) => {
  const { status, user, limit } = req.query;
  res.json(await store.getSlips({ status, user, limit: limit ? parseInt(limit) : 50 }));
});

// Get single slip
app.get('/api/slips/:id', async (req, res) => {
  const slip = await store.getSlip(req.params.id);
  if (!slip) return res.status(404).json({ error: 'Not found' });
  res.json(slip);
});

// Grade a slip
app.patch('/api/slips/:id/grade', async (req, res) => {
  const { results } = req.body;
  const result = await store.gradeSlip(req.params.id, results);
  if (result.error) return res.status(400).json(result);
  broadcast({ type: 'slip_graded', slip: result.slip });
  res.json(result);
});

// Delete slip
app.delete('/api/slips/:id', async (req, res) => {
  const { user } = req.body;
  const result = await store.deleteSlip(req.params.id, user);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Real player props from The Odds API (DraftKings, FanDuel, BetMGM)
// Falls back to ESPN season-average generated lines if no API key
app.get('/api/props/event/:eventId', async (req, res) => {
  try {
    if (!odds.isConfigured()) {
      return res.json({ source: 'none', error: 'No ODDS_API_KEY', data: [] });
    }
    const result = await odds.getPlayerProps(req.params.eventId);
    res.json({ source: 'odds-api', ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All upcoming game odds with real lines (cached 5min)
app.get('/api/real-odds', async (req, res) => {
  const cached = cache.get('real-odds');
  if (cached) return res.json(cached);

  try {
    if (!odds.isConfigured()) {
      return res.json({ source: 'espn', error: 'No ODDS_API_KEY — using ESPN embedded odds', data: [] });
    }
    const result = { source: 'odds-api', ...(await odds.getGameOdds('h2h,spreads,totals')) };
    cache.set('real-odds', result, TTL.GAME_ODDS);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate prop lines from player season averages (fallback when no API key)
app.get('/api/props/:teamId', async (req, res) => {
  try {
    const roster = await espn.getPlayerStats(req.params.teamId);
    const props = [];
    const overviews = await Promise.allSettled(
      roster.slice(0, 12).map(p => espn.getPlayerOverview(p.id))
    );

    roster.slice(0, 12).forEach((player, i) => {
      const ov = overviews[i]?.status === 'fulfilled' ? overviews[i].value : null;
      const s = ov?.season;
      if (!s?.avgPoints || parseFloat(s.avgPoints) < 2) return;

      const lines = [];
      const pts = parseFloat(s.avgPoints);
      const reb = parseFloat(s.avgRebounds);
      const ast = parseFloat(s.avgAssists);
      const stl = parseFloat(s.avgSteals);
      const blk = parseFloat(s.avgBlocks);

      if (pts >= 5) lines.push({ stat: 'PTS', line: Math.floor(pts ) + 0.5, avg: pts, source: 'model' });
      if (reb >= 2) lines.push({ stat: 'REB', line: Math.floor(reb ) + 0.5, avg: reb, source: 'model' });
      if (ast >= 1.5) lines.push({ stat: 'AST', line: Math.floor(ast ) + 0.5, avg: ast, source: 'model' });
      if (stl >= 0.5) lines.push({ stat: 'STL', line: Math.floor(stl ) + 0.5, avg: stl, source: 'model' });
      if (blk >= 0.5) lines.push({ stat: 'BLK', line: Math.floor(blk ) + 0.5, avg: blk, source: 'model' });
      if (pts >= 10) lines.push({ stat: 'PRA', line: Math.round((pts + reb + ast) * 2) / 2, avg: +(pts + reb + ast).toFixed(1), source: 'model' });
      const to = parseFloat(s.avgTurnovers || '0');
      if (to >= 1) lines.push({ stat: 'TO', line: Math.floor(to ) + 0.5, avg: to, source: 'model' });
      const ddCats = [pts, reb, ast].filter(v => v >= 8).length;
      if (ddCats >= 2) lines.push({ stat: 'Double-Double', line: 0.5, avg: 'Yes/No', source: 'model' });
      if (pts >= 15 && reb >= 7 && ast >= 7) lines.push({ stat: 'Triple-Double', line: 0.5, avg: 'Yes/No', source: 'model' });

      if (lines.length) {
        props.push({
          id: player.id, name: player.name, position: player.position,
          jersey: player.jersey, headshot: player.headshot, lines
        });
      }
    });

    res.json(props);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Merged props: real lines + model fallback, with Poisson fair value (cached 3min)
app.get('/api/props/game/:gameIndex', async (req, res) => {
  const window = req.query.window || 'season';
  const propsCacheKey = `props-game-${req.params.gameIndex}-${window}`;
  const propsCached = cache.get(propsCacheKey);
  if (propsCached) return res.json(propsCached);

  try {
    // Try sweep first (today's games), fall back to 7-day schedule
    const sweepCache = getCache();
    let game = sweepCache?.games?.[parseInt(req.params.gameIndex)];

    if (!game) {
      // Fall back to schedule — slips page indexes into the 7-day schedule
      const today = new Date();
      const end = new Date(today); end.setDate(end.getDate() + 7);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const schedUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${fmt(today)}-${fmt(end)}`;
      const sr = await fetch(schedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const sd = await sr.json();
      const schedGames = (sd.events || []).map(ev => {
        const comp = ev.competitions?.[0];
        const ts = comp?.competitors || [];
        const home = ts.find(t => t.homeAway === 'home');
        const away = ts.find(t => t.homeAway === 'away');
        return {
          id: ev.id, date: ev.date, status: comp?.status?.type?.description || 'Scheduled',
          home: { name: home?.team?.displayName || 'TBD', abbr: home?.team?.abbreviation || 'TBD', logo: home?.team?.logo || '' },
          away: { name: away?.team?.displayName || 'TBD', abbr: away?.team?.abbreviation || 'TBD', logo: away?.team?.logo || '' },
          odds: comp?.odds?.[0] ? { spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0, provider: comp.odds[0].provider?.name || '' } : null
        };
      });
      game = schedGames[parseInt(req.params.gameIndex)];
    }

    if (!game) return res.status(404).json({ error: 'Game not found at index ' + req.params.gameIndex });
    if (game.home.abbr === 'TBD' || game.away.abbr === 'TBD') return res.status(400).json({ error: 'TBD matchup' });

    let realProps = null;
    let realGameOdds = null;

    // Only try Odds API for today's games (conserve quota)
    const gameDate = new Date(game.date);
    const isToday = gameDate.toDateString() === new Date().toDateString();
    if (isToday && odds.isConfigured()) {
      const events = await odds.getEvents();
      const matchEvent = events.data?.find(e => {
        const h = e.home_team?.toLowerCase();
        const a = e.away_team?.toLowerCase();
        const gh = game.home.name.toLowerCase();
        const ga = game.away.name.toLowerCase();
        return (h?.includes(gh.split(' ').pop()) || gh.includes(h?.split(' ').pop())) &&
               (a?.includes(ga.split(' ').pop()) || ga.includes(a?.split(' ').pop()));
      });

      if (matchEvent) {
        const propsResult = await odds.getPlayerProps(matchEvent.id);
        if (propsResult.data) realProps = propsResult.data;
      }

      const gameOddsResult = await odds.getGameOdds();
      if (gameOddsResult.data) {
        realGameOdds = gameOddsResult.data.find(g => {
          const h = g.homeTeam?.toLowerCase();
          const gh = game.home.name.toLowerCase();
          return h?.includes(gh.split(' ').pop()) || gh.includes(h?.split(' ').pop());
        });
      }
    }

    const teams = sweepCache?.teams || await espn.getTeams();
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    // Build merged response
    const response = {
      game: { home: game.home, away: game.away, date: game.date, status: game.status },
      source: realProps ? 'odds-api' : 'model',
      gameLines: null,
      playerProps: []
    };

    // Game lines
    if (realGameOdds?.bookmakers?.length) {
      response.gameLines = {
        source: 'odds-api',
        books: realGameOdds.bookmakers.map(bk => {
          const markets = {};
          bk.markets.forEach(m => { markets[m.key] = m.outcomes; });
          return { name: bk.name, markets };
        })
      };
    } else if (game.odds) {
      response.gameLines = {
        source: 'espn',
        spread: game.odds.spread,
        overUnder: game.odds.overUnder,
        provider: game.odds.provider
      };
    }

    // Player props
    if (realProps?.length) {
      const realPlayerProps = realProps.map(p => ({
        name: p.name,
        source: 'odds-api',
        lines: p.lines.map(l => ({
          stat: l.stat,
          line: l.line,
          overOdds: l.bestOver?.odds || l.over?.odds || -110,
          underOdds: l.bestUnder?.odds || l.under?.odds || -110,
          book: l.bestOver?.book || l.over?.book || 'Best',
          allBooks: l.allBooks || []
        }))
      }));

      // Also generate model props and merge in missing stats (TO, DD, TD, etc.)
      const fetchModelProps = async (teamId, teamAbbr) => {
        if (!teamId) return [];
        const roster = await espn.getPlayerStats(teamId);
        const overviews = await Promise.allSettled(roster.slice(0, 10).map(p => espn.getPlayerOverview(p.id)));
        const result = [];
        roster.slice(0, 10).forEach((player, i) => {
          const ov = overviews[i]?.status === 'fulfilled' ? overviews[i].value : null;
          const s = ov?.season;
          if (!s?.avgPoints || parseFloat(s.avgPoints) < 2) return;
          const pts = parseFloat(s.avgPoints), reb = parseFloat(s.avgRebounds), ast = parseFloat(s.avgAssists);
          const to = parseFloat(s.avgTurnovers || '0');
          const lines = [];
          if (to >= 1) lines.push({ stat: 'TO', line: Math.floor(to ) + 0.5, overOdds: -115, underOdds: -115, book: 'Model', avg: to });
          const ddCats = [pts, reb, ast].filter(v => v >= 8).length;
          if (ddCats >= 2) {
            const ddProb = ddCats >= 3 ? 0.6 : (Math.min(pts,10)/10 * Math.min(reb,10)/10 * 0.8);
            const ddOdds = ddProb >= 0.5 ? Math.round(-100 * ddProb / (1-ddProb)) : Math.round(100 * (1-ddProb) / ddProb);
            lines.push({ stat: 'Double-Double', line: 0.5, overOdds: ddOdds, underOdds: -ddOdds, book: 'Model', avg: +(ddProb*100).toFixed(0)+'%' });
          }
          if (pts >= 15 && reb >= 7 && ast >= 7) {
            const tdProb = Math.min(pts,10)/10 * Math.min(reb,10)/10 * Math.min(ast,10)/10 * 0.3;
            lines.push({ stat: 'Triple-Double', line: 0.5, overOdds: Math.round(100*(1-tdProb)/tdProb), underOdds: -Math.round(100*(1-tdProb)/tdProb), book: 'Model', avg: +(tdProb*100).toFixed(1)+'%' });
          }
          if (lines.length) result.push({ name: player.name, lines });
        });
        return result;
      };
      const [hModel, aModel] = await Promise.all([
        fetchModelProps(homeTeam?.id, game.home.abbr),
        fetchModelProps(awayTeam?.id, game.away.abbr)
      ]);
      const allModel = [...aModel, ...hModel];

      // Merge model lines into real props for stats books don't cover
      const realByName = {};
      for (const p of realPlayerProps) realByName[p.name.toLowerCase()] = p;
      // Add model lines alongside book lines (tagged for comparison)
      for (const mp of allModel) {
        const key = mp.name.toLowerCase();
        if (realByName[key]) {
          for (const line of mp.lines) {
            realByName[key].lines.push({ ...line, source: 'model', book: 'Poisson' });
          }
        }
      }
      // Tag book lines
      for (const p of Object.values(realByName)) {
        p.lines = p.lines.map(l => l.source ? l : { ...l, source: 'book' });
      }
      response.playerProps = Object.values(realByName);
    } else {
      // Poisson model from actual gamelogs (not flat -115)
      const isPlayoffWindow = window === 'playoffs' || window === 'playoffs2026' || window.startsWith('PL');
      const fetchPoissonProps = async (teamId, teamAbbr) => {
        if (!teamId) return [];
        const roster = await espn.getPlayerStats(teamId);
        const top = roster.slice(0, 10);
        const gamelogs = await Promise.allSettled(top.map(p => espn.getPlayerGamelog(p.id)));
        const overviews = await Promise.allSettled(top.map(p => espn.getPlayerOverview(p.id)));
        const playoffData = isPlayoffWindow ? await Promise.allSettled(top.map(p => espn.getPlayerPlayoffStats(p.id))) : null;
        const result = [];

        const poisCdf = (k, lam) => {
          let sum = 0;
          for (let i = 0; i <= Math.floor(k); i++) {
            let term = Math.exp(-lam);
            for (let j = 1; j <= i; j++) term *= lam / j;
            sum += term;
          }
          return Math.min(sum, 1);
        };
        const toAm = (p) => p >= 0.5 ? Math.round(-100 * p / (1-p)) : Math.round(100 * (1-p) / p);

        for (let i = 0; i < top.length; i++) {
          const player = top[i];
          const gl = gamelogs[i].status === 'fulfilled' ? gamelogs[i].value : null;
          const ov = overviews[i]?.status === 'fulfilled' ? overviews[i].value : null;
          const s = ov?.season;
          const lines = [];

          const statDefs = [
            { key: 'PTS', label: 'PTS', min: 5 },
            { key: 'REB', label: 'REB', min: 2 },
            { key: 'AST', label: 'AST', min: 1.5 },
            { key: '3PM', label: '3PM', min: 0.5 },
            { key: 'FGM', label: 'FGM', min: 2 },
            { key: 'FTM', label: 'FTM', min: 1 },
            { key: 'STL', label: 'STL', min: 0.5 },
            { key: 'BLK', label: 'BLK', min: 0.5 },
            { key: 'TO', label: 'TO', min: 1 },
          ];

          const po = playoffData?.[i]?.status === 'fulfilled' ? playoffData[i].value : null;

          // Select values based on window
          const getVals = (key) => {
            if (window === 'playoffs') {
              return (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            } else if (window === 'playoffs2026') {
              return (po?.games || []).filter(g => g.season === 2026).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
            } else if (window.startsWith('PL')) {
              const n = parseInt(window.slice(2));
              const all = (po?.games || []).map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              return all.slice(0, Math.min(n, all.length));
            } else if (gl?.games?.length) {
              const all = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
              if (window === 'season') return all;
              const n = parseInt(window.replace('L', ''));
              return n > 0 ? all.slice(0, Math.min(n, all.length)) : all;
            }
            return [];
          };

          // Use gamelogs for Poisson if available
          if (gl?.games?.length >= 3 || (isPlayoffWindow && po?.games?.length >= 2)) {
            for (const sd of statDefs) {
              const vals = getVals(sd.key);
              if (vals.length < 3) continue;
              const mean = vals.reduce((a,b) => a+b, 0) / vals.length;
              if (mean < sd.min) continue;
              const line = Math.floor(mean) + 0.5;
              const overProb = 1 - poisCdf(line, mean);
              lines.push({
                stat: sd.label, line, avg: +mean.toFixed(1), games: vals.length,
                overOdds: toAm(overProb), underOdds: toAm(1 - overProb),
                overProb: +(overProb * 100).toFixed(1),
                book: 'Poisson'
              });
            }
            // PRA combo
            const ptsVals = gl.games.map(g => parseFloat(g.stats._PTS || '0'));
            const rebVals = gl.games.map(g => parseFloat(g.stats._REB || '0'));
            const astVals = gl.games.map(g => parseFloat(g.stats._AST || '0'));
            if (ptsVals.length >= 5) {
              const praVals = ptsVals.map((p, j) => p + (rebVals[j]||0) + (astVals[j]||0));
              const praMean = praVals.reduce((a,b) => a+b, 0) / praVals.length;
              if (praMean >= 10) {
                const praLine = Math.round(praMean * 2) / 2;
                const praOver = 1 - poisCdf(praLine, praMean);
                lines.push({ stat: 'PRA', line: praLine, avg: +praMean.toFixed(1), games: praVals.length, overOdds: toAm(praOver), underOdds: toAm(1-praOver), overProb: +(praOver*100).toFixed(1), book: 'Poisson' });
              }
            }
          } else if (s) {
            // Fallback to season averages if no gamelog
            const pts = parseFloat(s.avgPoints||0), reb = parseFloat(s.avgRebounds||0), ast = parseFloat(s.avgAssists||0);
            if (pts >= 5) lines.push({ stat: 'PTS', line: Math.floor(pts)+0.5, avg: pts, overOdds: -115, underOdds: -115, book: 'Model' });
            if (reb >= 2) lines.push({ stat: 'REB', line: Math.floor(reb)+0.5, avg: reb, overOdds: -115, underOdds: -115, book: 'Model' });
            if (ast >= 1.5) lines.push({ stat: 'AST', line: Math.floor(ast)+0.5, avg: ast, overOdds: -115, underOdds: -115, book: 'Model' });
          }

          // DD/TD from averages
          if (s) {
            const pts = parseFloat(s.avgPoints||0), reb = parseFloat(s.avgRebounds||0), ast = parseFloat(s.avgAssists||0);
            const ddCats = [pts,reb,ast].filter(v => v >= 8).length;
            if (ddCats >= 2) {
              const ddProb = ddCats >= 3 ? 0.6 : (Math.min(pts,10)/10 * Math.min(reb,10)/10 * 0.8);
              lines.push({ stat: 'Double-Double', line: 0.5, avg: +(ddProb*100).toFixed(0)+'%', overOdds: toAm(ddProb), underOdds: toAm(1-ddProb), book: 'Model' });
            }
            if (pts >= 15 && reb >= 7 && ast >= 7) {
              const tdProb = Math.min(pts,10)/10 * Math.min(reb,10)/10 * Math.min(ast,10)/10 * 0.3;
              lines.push({ stat: 'Triple-Double', line: 0.5, avg: +(tdProb*100).toFixed(1)+'%', overOdds: toAm(tdProb), underOdds: toAm(1-tdProb), book: 'Model' });
            }
          }

          if (lines.length) result.push({ name: player.name, team: teamAbbr, source: 'poisson', headshot: player.headshot, position: player.position, lines });
        }
        return result;
      };

      const [homeProps, awayProps] = await Promise.all([
        fetchPoissonProps(homeTeam?.id, game.home.abbr),
        fetchPoissonProps(awayTeam?.id, game.away.abbr)
      ]);
      response.playerProps = [...awayProps, ...homeProps];
      response.source = 'poisson';
    }

    cache.set(propsCacheKey, response, TTL.PROPS_MERGED);
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE: Live event stream
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
}

// Auto-sweep loop
async function sweepLoop() {
  try {
    const data = await runSweep(true);
    broadcast({ type: 'sweep', timestamp: data.timestamp, games: data.games, injuries: data.injuries });
  } catch (e) {
    console.error('[SWEEP-LOOP]', e.message);
  }
}

// === Auto-Resolver — runs every 5 min, grades ALL users' slips ===
async function autoResolve() {
  try {
    const result = await resolveEngine();
    if (result.resolved > 0) console.log(`[AUTO-RESOLVE] ${result.resolved} slips graded`);
  } catch (e) {
    console.error('[AUTO-RESOLVE]', e.message);
  }
}

// Legacy auto-resolve code replaced by resolveEngine above

// Admin resolve endpoint — no auth required, resolves ALL slips
app.post('/api/admin/resolve', async (req, res) => {
  try {
    await autoResolve();
    const slips = await store.getSlips({ limit: 200 });
    const active = slips.filter(s => s.status === 'active').length;
    const won = slips.filter(s => s.status === 'won').length;
    const lost = slips.filter(s => s.status === 'lost').length;
    res.json({ message: 'Auto-resolve complete', active, won, lost, total: slips.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export for Vercel serverless
export default app;

// Only start listener when running locally (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`\n  NBA PLAYOFF INTELLIGENCE TERMINAL`);
    console.log(`  ══════════════════════════════════`);
    console.log(`  Dashboard: http://localhost:${PORT}`);
    console.log(`  API:       http://localhost:${PORT}/api/sweep`);
    console.log(`  Stream:    http://localhost:${PORT}/api/stream`);
    console.log(`  ──────────────────────────────────`);
    console.log(`  Sources: ESPN (free) | NBA.com (free)`);
    console.log(`  Optional: ODDS_API_KEY, BDL_API_KEY`);
    console.log(`  ══════════════════════════════════\n`);

    await sweepLoop();
    setInterval(sweepLoop, 60_000);

    // Auto-resolve slips every 5 minutes
    setTimeout(autoResolve, 30_000); // first run 30s after start
    setInterval(autoResolve, 5 * 60_000);
    console.log('  Auto-resolver: every 5 min');
  });
}
