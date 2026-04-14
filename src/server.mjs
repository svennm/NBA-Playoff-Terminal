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
  const cacheKey = `analysis-game-${req.params.gameIndex}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const sweepData = getCache() || await runSweep();
    const game = sweepData?.games?.[parseInt(req.params.gameIndex)];
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // Get both team rosters
    const teams = sweepData?.teams || await espn.getTeams();
    const homeTeam = teams.find(t => t.abbr === game.home.abbr);
    const awayTeam = teams.find(t => t.abbr === game.away.abbr);

    const fetchTeamAnalysis = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const roster = await espn.getPlayerStats(teamId);
      const results = [];

      // Fetch gamelogs in parallel (top 10 players)
      const top = roster.slice(0, 10);
      const gamelogs = await Promise.allSettled(
        top.map(p => espn.getPlayerGamelog(p.id))
      );
      const overviews = await Promise.allSettled(
        top.map(p => espn.getPlayerOverview(p.id))
      );

      for (let i = 0; i < top.length; i++) {
        const player = top[i];
        const gl = gamelogs[i].status === 'fulfilled' ? gamelogs[i].value : null;
        const ov = overviews[i].status === 'fulfilled' ? overviews[i].value : null;
        if (!gl?.games?.length) continue;

        const season = ov?.season || {};
        const statKeys = ['PTS', 'REB', 'AST', '3PM', 'STL', 'BLK'];

        for (const key of statKeys) {
          const values = gl.games
            .map(g => parseFloat(g.stats[`_${key}`] || '0'))
            .filter(v => !isNaN(v));
          if (values.length < 10) continue;

          const n = values.length;
          const mean = values.reduce((a, b) => a + b, 0) / n;
          if (mean < 0.5) continue;
          const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
          const stdDev = Math.sqrt(variance);
          const dispersion = mean > 0 ? variance / mean : 0;

          // Poisson
          const lambda = mean;
          const poissonCdf = (k, lam) => {
            let sum = 0;
            for (let i = 0; i <= Math.floor(k); i++) {
              let term = Math.exp(-lam);
              for (let j = 1; j <= i; j++) term *= lam / j;
              sum += term;
            }
            return Math.min(sum, 1);
          };

          // Fit quality
          let fit = 'Poor';
          if (Math.abs(dispersion - 1) < 0.5) fit = 'Excellent';
          else if (Math.abs(dispersion - 1) < 1) fit = 'Good';
          else if (Math.abs(dispersion - 1) < 2) fit = 'Fair';

          // Generate lines at common half-points around the mean
          const line = Math.round(mean * 2) / 2;
          const overProb = +(1 - poissonCdf(line, lambda)).toFixed(4);
          const underProb = +poissonCdf(line, lambda).toFixed(4);

          const toAmerican = (prob) => prob >= 0.5
            ? Math.round(-100 * prob / (1 - prob))
            : Math.round(100 * (1 - prob) / prob);

          // Actual hit rate
          const actualOver = values.filter(v => v > line).length;

          results.push({
            player: player.name,
            playerId: player.id,
            team: teamAbbr,
            headshot: player.headshot || '',
            stat: key,
            line,
            mean: +mean.toFixed(1),
            stdDev: +stdDev.toFixed(1),
            games: n,
            // Poisson model
            modelOverProb: +(overProb * 100).toFixed(1),
            modelUnderProb: +(underProb * 100).toFixed(1),
            modelOverOdds: toAmerican(overProb),
            modelUnderOdds: toAmerican(underProb),
            // Actual
            actualOverPct: +(actualOver / n * 100).toFixed(1),
            // Quality
            poissonFit: fit,
            dispersion: +dispersion.toFixed(3),
            consistency: stdDev / mean < 0.2 ? 'High' : stdDev / mean < 0.35 ? 'Medium' : 'Low'
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
      rows: allRows,
      summary: {
        total: allRows.length,
        withEdge: 0 // client computes edge based on book lines
      }
    };

    cache.set(cacheKey, result, 5 * 60_000);
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
    const scores = await soccer.getScoreboard(req.params.league);
    const game = scores[parseInt(req.params.gameIndex)];
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
app.get('/api/book/auto-lines/:gameIndex', async (req, res) => {
  const ck = `auto-lines-${req.params.gameIndex}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const sweepData = getCache() || await runSweep();
    const game = sweepData?.games?.[parseInt(req.params.gameIndex)];
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const allTeams = sweepData?.teams || await espn.getTeams();
    const homeTeam = allTeams.find(t => t.abbr === game.home.abbr);
    const awayTeam = allTeams.find(t => t.abbr === game.away.abbr);

    const buildLines = async (teamId, teamAbbr) => {
      if (!teamId) return [];
      const roster = await espn.getPlayerStats(teamId);
      const results = [];

      for (const player of roster.slice(0, 12)) {
        const gl = await espn.getPlayerGamelog(player.id);
        if (!gl?.games?.length || gl.games.length < 10) continue;

        const statKeys = ['PTS', 'REB', 'AST', '3PM', 'STL', 'BLK'];
        for (const key of statKeys) {
          const allVals = gl.games.map(g => parseFloat(g.stats[`_${key}`] || '0')).filter(v => !isNaN(v));
          if (allVals.length < 10) continue;

          const compute = (vals) => {
            const n = vals.length;
            const mean = vals.reduce((a, b) => a + b, 0) / n;
            if (mean < 1 && key !== 'BLK' && key !== 'STL') return null;
            const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
            const line = Math.round(mean * 2) / 2;
            const poissonOver = 1 - poissonCdfCalc(line, mean);
            const toAm = (p) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
            return { mean: +mean.toFixed(1), stdDev: +Math.sqrt(variance).toFixed(1), line, games: n, overProb: +(poissonOver * 100).toFixed(1), overOdds: toAm(poissonOver), underOdds: toAm(1 - poissonOver) };
          };

          const full = compute(allVals);
          const l20 = allVals.length >= 20 ? compute(allVals.slice(-20)) : null;
          const l10 = allVals.length >= 10 ? compute(allVals.slice(-10)) : null;

          if (full) {
            results.push({
              player: player.name, playerId: player.id, team: teamAbbr,
              position: player.position, headshot: player.headshot, stat: key,
              models: { season: full, ...(l20 ? { L20: l20 } : {}), ...(l10 ? { L10: l10 } : {}) }
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
      game: { home: game.home, away: game.away },
      lines: [...awayLines, ...homeLines]
    };

    cache.set(ck, result, 5 * 60_000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poisson CDF helper for auto-lines
function poissonCdfCalc(k, lam) {
  let sum = 0;
  for (let i = 0; i <= Math.floor(k); i++) {
    let term = Math.exp(-lam);
    for (let j = 1; j <= i; j++) term *= lam / j;
    sum += term;
  }
  return Math.min(sum, 1);
}

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
    const distributions = {};

    for (const key of statKeys) {
      const values = gamelog.games
        .map(g => parseFloat(g.stats[`_${key}`] || g.stats[key] || '0'))
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

      // Histogram bins (8 bins)
      const binCount = 8;
      const binWidth = (max - min) / binCount || 1;
      const bins = Array(binCount).fill(0);
      const binEdges = [];
      for (let i = 0; i <= binCount; i++) binEdges.push(+(min + i * binWidth).toFixed(1));
      for (const v of values) {
        const idx = Math.min(Math.floor((v - min) / binWidth), binCount - 1);
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
      const lines = [0.5, mean - 0.5, mean, mean + 0.5].filter(l => l >= 0);
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

      // Poisson probabilities for over/under at key lines
      const poissonOU = [];
      if (isCountData && mean > 0) {
        const checkLines = [
          Math.floor(mean) - 2, Math.floor(mean) - 1, Math.floor(mean),
          Math.ceil(mean), Math.ceil(mean) + 1, Math.ceil(mean) + 2,
          Math.round(mean * 2) / 2 // common half-line
        ].filter(l => l >= 0);
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
    const scores = await soccer.getScoreboard(req.params.league);
    const game = scores[parseInt(req.params.gameIndex)];
    if (!game) return res.status(404).json({ error: 'Game not found' });

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
        const sportKey = req.params.league === 'uefa.champions' ? 'soccer_uefa_champs_league' : 'soccer_uefa_europa_league';

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

      // Merge: for each player, combine real book lines + model lines for missing stats
      const realByName = {};
      for (const p of realPlayerProps) realByName[p.name.toLowerCase()] = p;

      // Add model lines to real players for stats the books don't cover
      for (const mp of modelProps) {
        const key = mp.name.toLowerCase();
        if (realByName[key]) {
          const existingStats = new Set(realByName[key].lines.map(l => l.stat));
          for (const line of mp.lines || []) {
            if (!existingStats.has(line.stat)) {
              realByName[key].lines.push({ ...line, book: line.book || 'Model' });
            }
          }
        }
      }

      // Players only in model (no book lines at all)
      const realNames = new Set(Object.keys(realByName));
      playerProps = [
        ...Object.values(realByName),
        ...modelProps.filter(p => !realNames.has(p.name.toLowerCase()))
      ];
    } else {
      const [homeProps, awayProps] = await Promise.all([
        homeTeam ? soccer.getTeamProps(req.params.league, homeTeam.id) : [],
        awayTeam ? soccer.getTeamProps(req.params.league, awayTeam.id) : []
      ]);
      playerProps = [
        ...awayProps.map(p => ({ ...p, team: game.away.abbr })),
        ...homeProps.map(p => ({ ...p, team: game.home.abbr }))
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

      if (pts >= 5) lines.push({ stat: 'PTS', line: Math.round(pts * 2) / 2, avg: pts, source: 'model' });
      if (reb >= 2) lines.push({ stat: 'REB', line: Math.round(reb * 2) / 2, avg: reb, source: 'model' });
      if (ast >= 1.5) lines.push({ stat: 'AST', line: Math.round(ast * 2) / 2, avg: ast, source: 'model' });
      if (stl >= 0.5) lines.push({ stat: 'STL', line: Math.round(stl * 2) / 2, avg: stl, source: 'model' });
      if (blk >= 0.5) lines.push({ stat: 'BLK', line: Math.round(blk * 2) / 2, avg: blk, source: 'model' });
      if (pts >= 10) lines.push({ stat: 'PRA', line: Math.round((pts + reb + ast) * 2) / 2, avg: +(pts + reb + ast).toFixed(1), source: 'model' });
      const to = parseFloat(s.avgTurnovers || '0');
      if (to >= 1) lines.push({ stat: 'TO', line: Math.round(to * 2) / 2, avg: to, source: 'model' });
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
  const propsCacheKey = `props-game-${req.params.gameIndex}`;
  const propsCached = cache.get(propsCacheKey);
  if (propsCached) return res.json(propsCached);

  try {
    const sweepCache = getCache();
    const game = sweepCache?.games?.[parseInt(req.params.gameIndex)];
    if (!game) return res.status(404).json({ error: 'Game not found' });

    let realProps = null;
    let realGameOdds = null;

    // Try real odds first
    if (odds.isConfigured()) {
      // Get events to find the matching event ID
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

    // Get team IDs for ESPN fallback
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
          if (to >= 1) lines.push({ stat: 'TO', line: Math.round(to * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: to });
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
      for (const mp of allModel) {
        const key = mp.name.toLowerCase();
        if (realByName[key]) {
          const existingStats = new Set(realByName[key].lines.map(l => l.stat));
          for (const line of mp.lines) {
            if (!existingStats.has(line.stat)) realByName[key].lines.push(line);
          }
        }
      }
      response.playerProps = Object.values(realByName);
    } else {
      // Fallback to ESPN model
      const fetchProps = async (teamId, teamAbbr) => {
        if (!teamId) return [];
        const roster = await espn.getPlayerStats(teamId);
        const overviews = await Promise.allSettled(
          roster.slice(0, 10).map(p => espn.getPlayerOverview(p.id))
        );
        const result = [];
        roster.slice(0, 10).forEach((player, i) => {
          const ov = overviews[i]?.status === 'fulfilled' ? overviews[i].value : null;
          const s = ov?.season;
          if (!s?.avgPoints || parseFloat(s.avgPoints) < 2) return;
          const pts = parseFloat(s.avgPoints);
          const reb = parseFloat(s.avgRebounds);
          const ast = parseFloat(s.avgAssists);
          const stl = parseFloat(s.avgSteals);
          const blk = parseFloat(s.avgBlocks);
          const lines = [];
          if (pts >= 5) lines.push({ stat: 'PTS', line: Math.round(pts * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: pts });
          if (reb >= 2) lines.push({ stat: 'REB', line: Math.round(reb * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: reb });
          if (ast >= 1.5) lines.push({ stat: 'AST', line: Math.round(ast * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: ast });
          if (stl >= 0.5) lines.push({ stat: 'STL', line: Math.round(stl * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: stl });
          if (blk >= 0.5) lines.push({ stat: 'BLK', line: Math.round(blk * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: blk });
          if (pts >= 10) lines.push({ stat: 'PRA', line: Math.round((pts + reb + ast) * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: +(pts+reb+ast).toFixed(1) });
          // Turnovers
          const to = parseFloat(s.avgTurnovers || '0');
          if (to >= 1) lines.push({ stat: 'TO', line: Math.round(to * 2) / 2, overOdds: -115, underOdds: -115, book: 'Model', avg: to });
          // Double-Double: estimate from averages — if 2 stats near 10+
          const dd_cats = [pts, reb, ast].filter(v => v >= 8).length;
          if (dd_cats >= 2) {
            // Rough DD probability: if avg is near 10 in 2 cats, estimate ~40-70%
            const ddProb = dd_cats >= 3 ? 0.6 : (Math.min(pts,10)/10 * Math.min(reb,10)/10 * 0.8);
            const ddOdds = ddProb >= 0.5 ? Math.round(-100 * ddProb / (1 - ddProb)) : Math.round(100 * (1 - ddProb) / ddProb);
            lines.push({ stat: 'Double-Double', line: 0.5, overOdds: ddOdds, underOdds: -ddOdds, book: 'Model', avg: +(ddProb * 100).toFixed(0) + '%' });
          }
          // Triple-Double: only for elite playmakers
          if (pts >= 15 && reb >= 7 && ast >= 7) {
            const tdProb = Math.min(pts,10)/10 * Math.min(reb,10)/10 * Math.min(ast,10)/10 * 0.3;
            const tdOdds = Math.round(100 * (1 - tdProb) / tdProb);
            lines.push({ stat: 'Triple-Double', line: 0.5, overOdds: tdOdds, underOdds: Math.round(-100 * (1-tdProb) / tdProb), book: 'Model', avg: +(tdProb * 100).toFixed(1) + '%' });
          }
          if (lines.length) result.push({ name: player.name, team: teamAbbr, source: 'model', headshot: player.headshot, position: player.position, lines });
        });
        return result;
      };

      const [homeProps, awayProps] = await Promise.all([
        fetchProps(homeTeam?.id, game.home.abbr),
        fetchProps(awayTeam?.id, game.away.abbr)
      ]);
      response.playerProps = [...awayProps, ...homeProps];
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
  });
}
