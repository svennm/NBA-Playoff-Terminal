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

export { LEAGUES };
export default { getScoreboard, getStandings, getTeams, getNews, getTeamRoster, getTeamDetail, LEAGUES };
