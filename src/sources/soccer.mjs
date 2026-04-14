// ESPN Soccer API — Champions League + expandable to other leagues
// No API key required

const LEAGUES = {
  'uefa.champions': { name: 'UEFA Champions League', abbr: 'UCL' },
  'uefa.europa': { name: 'UEFA Europa League', abbr: 'UEL' },
  'eng.1': { name: 'English Premier League', abbr: 'EPL' },
  'esp.1': { name: 'La Liga', abbr: 'LaLiga' },
};

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

async function safeFetch(url, label) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[SOCCER:${label}] ${e.message}`);
    return null;
  }
}

export async function getScoreboard(league = 'uefa.champions') {
  const data = await safeFetch(`${BASE}/${league}/scoreboard`, `scoreboard-${league}`);
  if (!data?.events) return [];
  return data.events.map(ev => {
    const comp = ev.competitions?.[0];
    const teams = comp?.competitors || [];
    const home = teams.find(t => t.homeAway === 'home');
    const away = teams.find(t => t.homeAway === 'away');
    return {
      id: ev.id,
      name: ev.name,
      shortName: ev.shortName,
      date: ev.date,
      status: comp?.status?.type?.description || 'Unknown',
      clock: comp?.status?.displayClock || '',
      period: comp?.status?.period || 0,
      home: {
        name: home?.team?.displayName || '',
        abbr: home?.team?.abbreviation || '',
        logo: home?.team?.logo || '',
        score: home?.score || '0',
        record: home?.records?.[0]?.summary || '',
        form: home?.form || ''
      },
      away: {
        name: away?.team?.displayName || '',
        abbr: away?.team?.abbreviation || '',
        logo: away?.team?.logo || '',
        score: away?.score || '0',
        record: away?.records?.[0]?.summary || '',
        form: away?.form || ''
      },
      venue: comp?.venue?.fullName || '',
      broadcast: comp?.broadcasts?.[0]?.names?.join(', ') || '',
      aggregate: comp?.notes?.[0]?.headline || '',
      odds: comp?.odds?.[0] ? {
        spread: comp.odds[0].details || '',
        overUnder: comp.odds[0].overUnder || 0,
        provider: comp.odds[0].provider?.name || ''
      } : null
    };
  });
}

export async function getStandings(league = 'uefa.champions') {
  const data = await safeFetch(
    `https://site.api.espn.com/apis/v2/sports/soccer/${league}/standings`,
    `standings-${league}`
  );
  if (!data?.children) return [];
  const groups = [];
  for (const child of data.children) {
    const entries = (child.standings?.entries || []).map(e => {
      const stats = {};
      for (const s of e.stats || []) stats[s.name] = s.displayValue || s.value;
      return {
        team: e.team?.displayName || '',
        abbr: e.team?.abbreviation || '',
        logo: e.team?.logos?.[0]?.href || '',
        rank: stats.rank || '?',
        wins: stats.wins || '0',
        draws: stats.draws || '0',
        losses: stats.losses || '0',
        points: stats.points || '0',
        gf: stats.pointsFor || stats.goalsFor || '0',
        ga: stats.pointsAgainst || stats.goalsAgainst || '0',
        gd: stats.goalDifference || stats.pointDifferential || '0',
        gp: stats.gamesPlayed || '0'
      };
    });
    groups.push({ name: child.name || 'League', entries });
  }
  return groups;
}

export async function getTeams(league = 'uefa.champions') {
  const data = await safeFetch(`${BASE}/${league}/teams`, `teams-${league}`);
  if (!data?.sports?.[0]?.leagues?.[0]?.teams) return [];
  return data.sports[0].leagues[0].teams.map(t => ({
    id: t.team.id,
    name: t.team.displayName,
    abbr: t.team.abbreviation,
    logo: t.team.logos?.[0]?.href || '',
    color: t.team.color || '000000'
  }));
}

export async function getNews(league = 'uefa.champions') {
  const data = await safeFetch(`${BASE}/${league}/news`, `news-${league}`);
  if (!data?.articles) return [];
  return data.articles.slice(0, 12).map(a => ({
    headline: a.headline,
    description: a.description || '',
    published: a.published,
    link: a.links?.web?.href || '',
    image: a.images?.[0]?.url || ''
  }));
}

export async function getTeamRoster(league, teamId) {
  const data = await safeFetch(`${BASE}/${league}/teams/${teamId}/roster`, `roster-${teamId}`);
  if (!data?.athletes) return [];
  return data.athletes.flatMap(group => {
    const items = group.items?.length ? group.items : [group];
    return items.map(p => ({
      id: p.id || '',
      name: p.displayName || p.fullName || '',
      position: p.position?.abbreviation || '',
      jersey: p.jersey || '',
      age: p.age || 0,
      nationality: p.citizenship || '',
      headshot: p.headshot?.href || ''
    }));
  });
}

export async function getTeamDetail(league, teamId) {
  const data = await safeFetch(`${BASE}/${league}/teams/${teamId}`, `detail-${teamId}`);
  if (!data?.team) return null;
  const t = data.team;
  return {
    id: t.id,
    name: t.displayName,
    abbr: t.abbreviation,
    logo: t.logos?.[0]?.href || '',
    color: t.color || '000000',
    record: t.record?.items?.[0]?.summary || '',
    standingSummary: t.standingSummary || '',
    nextEvent: t.nextEvent?.[0] ? {
      name: t.nextEvent[0].shortName || t.nextEvent[0].name,
      date: t.nextEvent[0].date
    } : null
  };
}

export async function getPlayerOverview(league, playerId) {
  const data = await safeFetch(
    `https://site.api.espn.com/apis/common/v3/sports/soccer/${league}/athletes/${playerId}/overview`,
    `player-${league}-${playerId}`
  );
  if (!data) return null;

  const stats = data.statistics || {};
  const labels = stats.labels || [];
  const names = stats.names || [];
  const splits = stats.splits || [];

  const parseSplit = (split) => {
    if (!split) return {};
    const obj = {};
    names.forEach((n, i) => { obj[n] = split.stats?.[i] || '0'; });
    labels.forEach((l, i) => { obj[`_${l}`] = split.stats?.[i] || '0'; });
    return obj;
  };

  // Get the CL or league split
  const clSplit = splits.find(s => s.displayName?.includes('Champions League'));
  const leagueSplit = splits.find(s => s.displayName?.includes('LALIGA') || s.displayName?.includes('Premier') || s.displayName?.includes('Serie') || s.displayName?.includes('Bundesliga') || s.displayName?.includes('Ligue'));

  // Last 5 gamelog
  const gl = data.gameLog?.statistics?.[0] || {};
  const glLabels = gl.labels || [];
  const glEvents = (gl.events || []).map(e => {
    const obj = {};
    glLabels.forEach((l, i) => { obj[l] = e.stats?.[i] || '0'; });
    return obj;
  });

  return {
    clStats: clSplit ? parseSplit(clSplit) : null,
    leagueStats: leagueSplit ? parseSplit(leagueSplit) : null,
    clSplitName: clSplit?.displayName || null,
    leagueSplitName: leagueSplit?.displayName || null,
    allSplits: splits.map(s => ({ name: s.displayName, stats: parseSplit(s) })),
    last5: glEvents,
    last5Labels: glLabels,
    news: data.news,
    nextGame: data.nextGame
  };
}

export async function getTeamProps(league, teamId) {
  const roster = await getTeamRoster(league, teamId);
  if (!roster.length) return [];

  // Get stats for all outfield players + starting goalkeeper
  const posOrder = { F: 0, M: 1, D: 2, G: 3 };
  const goalkeepers = roster.filter(p => p.position === 'G').slice(0, 1);
  const outfield = roster
    .filter(p => p.position !== 'G')
    .sort((a, b) => (posOrder[a.position] ?? 3) - (posOrder[b.position] ?? 3))
    .slice(0, 18);
  const top = [...outfield, ...goalkeepers];
  const overviews = await Promise.allSettled(
    top.map(p => getPlayerOverview(league, p.id))
  );

  const props = [];
  top.forEach((player, i) => {
    const ov = overviews[i]?.status === 'fulfilled' ? overviews[i].value : null;
    if (!ov) return;

    // Use CL stats first, then league stats
    const s = ov.clStats || ov.leagueStats;
    if (!s) return;

    const gp = parseInt(s.starts || s._STRT || '0') || 1;
    const goals = parseFloat(s.totalGoals || s._G || '0');
    const assists = parseFloat(s.goalAssists || s._A || '0');
    const shots = parseFloat(s.totalShots || s._SH || '0');
    const sot = parseFloat(s.shotsOnTarget || s._ST || '0');
    const fouls = parseFloat(s.foulsCommitted || s._FC || '0');

    const lines = [];
    const gpg = goals / gp;
    const apg = assists / gp;
    const shpg = shots / gp;
    const sotpg = sot / gp;

    // Poisson CDF: P(X <= k) for lambda
    const poissonCdf = (k, lam) => {
      let sum = 0;
      for (let i = 0; i <= Math.floor(k); i++) {
        let term = Math.exp(-lam);
        for (let j = 1; j <= i; j++) term *= lam / j;
        sum += term;
      }
      return Math.min(sum, 1);
    };

    const makeLine = (stat, avg, total, gp) => {
      const line = Math.round(avg * 2) / 2 || 0.5;
      const overProb = 1 - poissonCdf(line, avg);
      const underProb = poissonCdf(line, avg);
      const toAmerican = (p) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
      return {
        stat, line, avg: +avg.toFixed(2), total, gp,
        overOdds: toAmerican(overProb),
        underOdds: toAmerican(underProb),
        overProb: +(overProb * 100).toFixed(1),
        underProb: +(underProb * 100).toFixed(1),
        book: 'Poisson'
      };
    };

    if (goals >= 1) lines.push(makeLine('Goals', gpg, goals, gp));
    if (assists >= 1) lines.push(makeLine('Assists', apg, assists, gp));
    if (shots >= 3) lines.push(makeLine('Shots', shpg, shots, gp));
    if (sot >= 2) lines.push(makeLine('SOT', sotpg, sot, gp));
    if (goals + assists >= 1) lines.push(makeLine('G+A', gpg + apg, goals + assists, gp));
    // Fouls and cards — popular soccer markets
    if (fouls >= 3) lines.push(makeLine('Fouls', fouls / gp, fouls, gp));
    const yc = parseFloat(s.yellowCards || s._YC || '0');
    if (yc >= 1) lines.push(makeLine('Cards', yc / gp, yc, gp));

    // Goalkeeper props — saves, fouls suffered (proxy for activity)
    if (player.position === 'G' && gp >= 1) {
      const saves = parseFloat(s.saves || s._SV || '0');
      const ga = parseFloat(s.goalsConceded || s._GA || '0');
      if (saves >= 1) lines.push(makeLine('Saves', saves / gp, saves, gp));
      // Clean sheet implied: games with 0 goals conceded
      if (gp >= 3) {
        const csRate = ga > 0 ? Math.max(0, 1 - (ga / gp)) : 1;
        lines.push({
          stat: 'Clean Sheet', line: 0.5, avg: +csRate.toFixed(2), total: Math.round(csRate * gp), gp,
          overOdds: csRate >= 0.5 ? Math.round(-100 * csRate / (1 - csRate)) : Math.round(100 * (1 - csRate) / csRate),
          underOdds: csRate >= 0.5 ? Math.round(100 * (1 - csRate) / csRate) : Math.round(-100 * csRate / (1 - csRate)),
          overProb: +(csRate * 100).toFixed(1),
          underProb: +((1 - csRate) * 100).toFixed(1),
          book: 'Model'
        });
      }
      // Yellow card prop for GK
      if (fouls >= 1) lines.push(makeLine('Fouls', fouls / gp, fouls, gp));
    }

    if (lines.length) {
      props.push({
        id: player.id,
        name: player.name,
        position: player.position,
        jersey: player.jersey,
        headshot: player.headshot,
        source: ov.clStats ? 'UCL' : 'League',
        lines
      });
    }
  });

  return props;
}

export { LEAGUES };
export default { getScoreboard, getStandings, getTeams, getNews, getTeamRoster, getTeamDetail, getPlayerOverview, getTeamProps, LEAGUES };
