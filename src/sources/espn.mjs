// ESPN Public API - No API key required
// Covers: live scores, standings, news, injuries, team stats, schedule

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const STATS_BASE = 'https://site.web.api.espn.com/apis/v2/sports/basketball/nba';

async function safeFetch(url, label, timeoutMs = 10000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[ESPN:${label}] ${e.message}`);
    return null;
  }
}

export async function getScoreboard() {
  const data = await safeFetch(`${BASE}/scoreboard`, 'scoreboard');
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
      statusDetail: comp?.status?.type?.detail || '',
      clock: comp?.status?.displayClock || '',
      period: comp?.status?.period || 0,
      home: {
        name: home?.team?.displayName || '',
        abbr: home?.team?.abbreviation || '',
        logo: home?.team?.logo || '',
        score: home?.score || '0',
        record: home?.records?.[0]?.summary || '',
        seed: home?.curatedRank?.current || 0
      },
      away: {
        name: away?.team?.displayName || '',
        abbr: away?.team?.abbreviation || '',
        logo: away?.team?.logo || '',
        score: away?.score || '0',
        record: away?.records?.[0]?.summary || '',
        seed: away?.curatedRank?.current || 0
      },
      broadcast: comp?.broadcasts?.[0]?.names?.join(', ') || '',
      venue: comp?.venue?.fullName || '',
      odds: comp?.odds?.[0] ? {
        spread: comp.odds[0].details || '',
        overUnder: comp.odds[0].overUnder || 0,
        provider: comp.odds[0].provider?.name || ''
      } : null,
      leaders: (comp?.leaders || []).map(l => ({
        category: l.name,
        leader: l.leaders?.[0] ? {
          name: l.leaders[0].athlete?.displayName || '',
          value: l.leaders[0].displayValue || ''
        } : null
      }))
    };
  });
}

export async function getPlayInScoreboard() {
  const data = await safeFetch(`${BASE}/scoreboard?seasontype=5`, 'playin-scoreboard');
  if (!data?.events) return [];
  return data.events.map(ev => {
    const comp = ev.competitions?.[0];
    const teams = comp?.competitors || [];
    const home = teams.find(t => t.homeAway === 'home');
    const away = teams.find(t => t.homeAway === 'away');
    return {
      id: ev.id, name: ev.name, shortName: ev.shortName, date: ev.date,
      status: comp?.status?.type?.description || 'Unknown',
      statusDetail: comp?.status?.type?.detail || '',
      clock: comp?.status?.displayClock || '',
      period: comp?.status?.period || 0,
      isPlayIn: true,
      home: {
        name: home?.team?.displayName || '', abbr: home?.team?.abbreviation || '',
        logo: home?.team?.logo || '', score: home?.score || '0',
        record: home?.records?.[0]?.summary || '', seed: home?.curatedRank?.current || 0
      },
      away: {
        name: away?.team?.displayName || '', abbr: away?.team?.abbreviation || '',
        logo: away?.team?.logo || '', score: away?.score || '0',
        record: away?.records?.[0]?.summary || '', seed: away?.curatedRank?.current || 0
      },
      broadcast: comp?.broadcasts?.[0]?.names?.join(', ') || '',
      venue: comp?.venue?.fullName || '',
      odds: comp?.odds?.[0] ? {
        spread: comp.odds[0].details || '', overUnder: comp.odds[0].overUnder || 0,
        provider: comp.odds[0].provider?.name || ''
      } : null,
      leaders: (comp?.leaders || []).map(l => ({
        category: l.name,
        leader: l.leaders?.[0] ? { name: l.leaders[0].athlete?.displayName || '', value: l.leaders[0].displayValue || '' } : null
      }))
    };
  });
}

export async function getStandings() {
  const data = await safeFetch(
    'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2026&type=1',
    'standings'
  );
  if (!data?.children) return { east: [], west: [] };
  const conferences = {};
  for (const conf of data.children) {
    const name = conf.name?.toLowerCase().includes('east') ? 'east' : 'west';
    conferences[name] = (conf.standings?.entries || []).map(entry => {
      const stats = {};
      for (const s of entry.stats || []) {
        stats[s.name] = s.displayValue || s.value;
      }
      return {
        team: entry.team?.displayName || '',
        abbr: entry.team?.abbreviation || '',
        logo: entry.team?.logos?.[0]?.href || '',
        wins: stats.wins || '0',
        losses: stats.losses || '0',
        pct: stats.winPercent || '.000',
        gb: stats.gamesBehind || '0',
        streak: stats.streak || '-',
        last10: stats.record_last_10 || '-',
        ppg: stats.pointsFor || '0',
        oppg: stats.pointsAgainst || '0',
        diff: stats.differential || '0',
        seed: stats.playoffSeed || '0'
      };
    }).sort((a, b) => Number(b.pct) - Number(a.pct));
  }
  return conferences;
}

export async function getNews() {
  const data = await safeFetch(`${BASE}/news`, 'news');
  if (!data?.articles) return [];
  return data.articles.slice(0, 15).map(a => ({
    headline: a.headline,
    description: a.description || '',
    published: a.published,
    link: a.links?.web?.href || '',
    image: a.images?.[0]?.url || ''
  }));
}

export async function getTeams() {
  const data = await safeFetch(`${BASE}/teams`, 'teams');
  if (!data?.sports?.[0]?.leagues?.[0]?.teams) return [];
  return data.sports[0].leagues[0].teams.map(t => ({
    id: t.team.id,
    name: t.team.displayName,
    abbr: t.team.abbreviation,
    logo: t.team.logos?.[0]?.href || '',
    color: t.team.color || '000000',
    altColor: t.team.alternateColor || 'ffffff',
    record: t.team.record?.items?.[0]?.summary || ''
  }));
}

export async function getPlayoffBracket() {
  const data = await safeFetch(
    'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2026&type=5',
    'playoffs'
  );
  return data;
}

export async function getInjuries() {
  const data = await safeFetch(
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
    'injuries'
  );
  if (!data?.injuries) return [];
  return data.injuries.flatMap(team => {
    const teamName = team.team?.displayName || '';
    const teamAbbr = team.team?.abbreviation || '';
    return (team.injuries || []).map(inj => ({
      team: teamName,
      teamAbbr,
      player: inj.athlete?.displayName || '',
      position: inj.athlete?.position?.abbreviation || '',
      status: inj.status || '',
      date: inj.date || '',
      detail: inj.longComment || inj.shortComment || '',
      type: inj.type || ''
    }));
  });
}

export async function getSchedule(dates) {
  const params = dates ? `?dates=${dates}` : '';
  const data = await safeFetch(`${BASE}/scoreboard${params}`, 'schedule');
  if (!data?.events) return [];
  return data.events.map(ev => ({
    id: ev.id,
    name: ev.shortName || ev.name,
    date: ev.date,
    status: ev.status?.type?.description || '',
    venue: ev.competitions?.[0]?.venue?.fullName || ''
  }));
}

export async function getPlayerStats(teamId) {
  const data = await safeFetch(
    `${BASE}/teams/${teamId}/roster`,
    `roster-${teamId}`
  );
  if (!data?.athletes) return [];

  // ESPN roster can be flat (each athlete is a direct object) or grouped (items array)
  return data.athletes.map(p => {
    // If it's a group with items, extract items
    if (p.items?.length) {
      return p.items.map(item => ({
        id: item.id || '',
        name: item.displayName || item.fullName || '',
        position: item.position?.abbreviation || '',
        jersey: item.jersey || '',
        age: item.age || 0,
        height: item.displayHeight || '',
        weight: item.displayWeight || '',
        experience: item.experience?.years || 0,
        headshot: item.headshot?.href || ''
      }));
    }
    // Flat athlete object
    return {
      id: p.id || '',
      name: p.displayName || p.fullName || '',
      position: p.position?.abbreviation || '',
      jersey: p.jersey || '',
      age: p.age || 0,
      height: p.displayHeight || '',
      weight: p.displayWeight || '',
      experience: p.experience?.years || 0,
      headshot: p.headshot?.href || ''
    };
  }).flat();
}

export async function getTeamDetail(teamId) {
  const data = await safeFetch(`${BASE}/teams/${teamId}`, `team-${teamId}`);
  if (!data?.team) return null;
  const t = data.team;
  const record = t.record?.items || [];
  const overall = record.find(r => r.type === 'total');
  const home = record.find(r => r.type === 'home');
  const away = record.find(r => r.type === 'road');

  const parseRecord = (r) => {
    if (!r) return {};
    const stats = {};
    for (const s of r.stats || []) stats[s.name] = s.value;
    return { summary: r.summary, ...stats };
  };

  return {
    id: t.id,
    name: t.displayName,
    abbr: t.abbreviation,
    location: t.location,
    color: t.color || '000000',
    altColor: t.alternateColor || 'ffffff',
    logo: t.logos?.[0]?.href || '',
    record: parseRecord(overall),
    homeRecord: parseRecord(home),
    awayRecord: parseRecord(away),
    standingSummary: t.standingSummary || '',
    nextEvent: t.nextEvent?.[0] ? {
      name: t.nextEvent[0].shortName || t.nextEvent[0].name,
      date: t.nextEvent[0].date
    } : null
  };
}

export async function getTeamStats(teamId) {
  const data = await safeFetch(
    `${BASE}/teams/${teamId}/statistics`,
    `stats-${teamId}`
  );
  if (!data?.results?.stats?.categories) return {};
  const out = {};
  for (const cat of data.results.stats.categories) {
    for (const s of cat.stats || []) {
      out[s.abbreviation || s.name] = {
        value: s.value,
        display: s.displayValue,
        name: s.displayName,
        perGame: s.perGameDisplayValue || null
      };
    }
  }
  return out;
}

export async function getPlayerOverview(playerId) {
  const data = await safeFetch(
    `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/overview`,
    `player-${playerId}`
  );
  if (!data) return null;

  const stats = data.statistics || {};
  const labels = stats.labels || [];
  const names = stats.names || [];
  const splits = stats.splits || [];
  const season = splits.find(s => s.displayName === 'Regular Season');
  const career = splits.find(s => s.displayName === 'Career');

  const parseSplit = (split) => {
    if (!split) return {};
    const obj = {};
    names.forEach((n, i) => {
      obj[n] = split.stats[i];
    });
    labels.forEach((l, i) => {
      obj[`_${l}`] = split.stats[i];
    });
    return obj;
  };

  return {
    season: parseSplit(season),
    career: parseSplit(career),
    labels,
    names,
    news: (data.news?.items || []).slice(0, 3).map(n => ({
      headline: n.headline,
      description: n.description || ''
    })),
    nextGame: data.nextGame ? {
      name: data.nextGame.shortName || data.nextGame.name || '',
      date: data.nextGame.date || ''
    } : null
  };
}

export async function getPlayerGamelog(playerId, season = '2026') {
  const data = await safeFetch(
    `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/gamelog?season=${season}`,
    `gamelog-${playerId}`
  );
  if (!data) return null;

  const labels = data.labels || [];
  const names = data.names || [];
  const displayNames = data.displayNames || [];
  const events = data.events || {};
  const seasonTypes = data.seasonTypes || [];

  const games = [];
  for (const st of seasonTypes) {
    if (st.displayName && !st.displayName.includes('Regular')) continue;
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const stats = {};
        (ev.stats || []).forEach((val, i) => {
          if (names[i]) stats[names[i]] = val;
          if (labels[i]) stats[`_${labels[i]}`] = val;
        });
        games.push({
          eventId: ev.eventId,
          stats
        });
      }
    }
  }

  return { labels, names, displayNames, games };
}

export async function getPlayerPlayoffStats(playerId) {
  // Get career playoff + play-in gamelogs
  // Fetch full career playoff history in parallel (2003-2026)
  // Covers LeBron from rookie year, KD from 2010, etc.
  // 24 parallel requests ~800ms total
  const years = [];
  for (let y = 2026; y >= 2003; y--) years.push(y);
  const allGames = [];
  const labels = ['MIN','FG','FG%','3PT','3P%','FT','FT%','REB','AST','BLK','STL','PF','TO','PTS'];
  const names = ['minutes','fieldGoalsMade-fieldGoalsAttempted','fieldGoalPct',
    'threePointFieldGoalsMade-threePointFieldGoalsAttempted','threePointPct',
    'freeThrowsMade-freeThrowsAttempted','freeThrowPct',
    'totalRebounds','assists','blocks','steals','fouls','turnovers','points'];
  const seenEvents = new Set();

  // Fetch all years in parallel for speed
  const yearResults = await Promise.allSettled(
    years.map(year => safeFetch(
      `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/gamelog?season=${year}&seasontype=3`,
      `playoff-gamelog-${playerId}-${year}`,
      8000
    ))
  );

  for (let yi = 0; yi < years.length; yi++) {
    const data = yearResults[yi].status === 'fulfilled' ? yearResults[yi].value : null;
    if (!data?.seasonTypes) continue;
    for (const st of data.seasonTypes) {
      if (!st.displayName?.includes('Postseason') && !st.displayName?.includes('Play-In') && !st.displayName?.includes('Play In')) continue;
      for (const cat of st.categories || []) {
        const round = cat.displayName || '';
        for (const ev of cat.events || []) {
          if (seenEvents.has(ev.eventId)) continue;
          seenEvents.add(ev.eventId);
          const stats = {};
          (ev.stats || []).forEach((val, i) => {
            if (labels[i]) stats[`_${labels[i]}`] = val;
            if (names[i]) stats[names[i]] = val;
          });
          allGames.push({ season: years[yi], round, eventId: ev.eventId, stats, type: 'playoff' });
        }
      }
    }
  }

  // Also fetch current year play-in (seasontype=5) separately
  const playInData = await safeFetch(
    `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/gamelog?season=2026&seasontype=5`,
    `playin-gamelog-${playerId}-2026`,
    8000
  );
  if (playInData?.seasonTypes) {
    for (const st of playInData.seasonTypes) {
      if (!st.displayName?.includes('Play-In') && !st.displayName?.includes('Play In')) continue;
      for (const cat of st.categories || []) {
        for (const ev of cat.events || []) {
          if (seenEvents.has(ev.eventId)) continue;
          seenEvents.add(ev.eventId);
          const stats = {};
          (ev.stats || []).forEach((val, i) => {
            if (labels[i]) stats[`_${labels[i]}`] = val;
            if (names[i]) stats[names[i]] = val;
          });
          allGames.push({ season: 2026, round: 'Play-In', eventId: ev.eventId, stats, type: 'play-in' });
        }
      }
    }
  }

  // Also get career playoff splits for this season
  const splits = await safeFetch(
    `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${playerId}/splits?season=2025&seasontype=3`,
    `playoff-splits-${playerId}`,
    8000
  );

  let careerPlayoffAvg = null;
  let playoffSplits = {};
  if (splits?.splitCategories) {
    const splitLabels = splits.labels || [];
    const splitNames = splits.names || [];
    for (const sc of splits.splitCategories) {
      for (const sp of sc.splits || []) {
        const obj = {};
        (sp.stats || []).forEach((val, i) => {
          if (splitLabels[i]) obj[splitLabels[i]] = val;
        });
        if (sp.displayName === 'All Splits') careerPlayoffAvg = obj;
        else playoffSplits[sp.displayName] = obj;
      }
    }
  }

  return { games: allGames, careerPlayoffAvg, playoffSplits, totalGames: allGames.length };
}

export async function getTeamSchedule(teamId, season = '2026') {
  const data = await safeFetch(
    `${BASE}/teams/${teamId}/schedule?season=${season}&seasontype=2`,
    `schedule-${teamId}`
  );
  if (!data?.events) return [];

  return data.events.map(ev => {
    const comp = ev.competitions?.[0];
    const teams = comp?.competitors || [];
    const us = teams.find(t => t.id === String(teamId) || t.team?.id === String(teamId));
    const them = teams.find(t => t !== us);
    const isHome = us?.homeAway === 'home';
    const won = us?.winner === true;

    return {
      date: ev.date,
      opponent: them?.team?.abbreviation || '?',
      opponentName: them?.team?.displayName || '?',
      home: isHome,
      won,
      score: typeof us?.score === 'object' ? us.score.displayValue : String(us?.score || '0'),
      oppScore: typeof them?.score === 'object' ? them.score.displayValue : String(them?.score || '0'),
      status: comp?.status?.type?.description || 'Final'
    };
  }).filter(g => g.status === 'Final');
}

export default {
  getScoreboard,
  getPlayInScoreboard,
  getStandings,
  getNews,
  getTeams,
  getInjuries,
  getSchedule,
  getPlayoffBracket,
  getPlayerStats,
  getTeamDetail,
  getTeamStats,
  getPlayerOverview,
  getPlayerGamelog,
  getPlayerPlayoffStats,
  getTeamSchedule
};
