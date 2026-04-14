// The Odds API - Free tier: 500 requests/month
// Sign up at https://the-odds-api.com to get a free key
// Set ODDS_API_KEY in .env or environment
//
// Covers: game lines (spread, total, moneyline) + player props from
// DraftKings, FanDuel, BetMGM, Caesars, etc.

const BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'basketball_nba';

function getKey() {
  return process.env.ODDS_API_KEY || '';
}

async function safeFetch(url, label) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    if (remaining) console.log(`[ODDS:${label}] Remaining: ${remaining} | Used: ${used}`);
    return await res.json();
  } catch (e) {
    console.error(`[ODDS:${label}] ${e.message}`);
    return null;
  }
}

export function isConfigured() {
  return !!getKey();
}

// Game lines: spreads, totals, moneylines
export async function getGameOdds(markets = 'h2h,spreads,totals') {
  const key = getKey();
  if (!key) return { error: 'No ODDS_API_KEY set. Get free key at https://the-odds-api.com', data: [] };

  const url = `${BASE}/sports/${SPORT}/odds/?apiKey=${key}&regions=us&markets=${markets}&oddsFormat=american`;
  const data = await safeFetch(url, 'game-odds');
  if (!data) return { error: 'Failed to fetch odds', data: [] };

  return {
    error: null,
    data: data.map(game => ({
      id: game.id,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      startTime: game.commence_time,
      bookmakers: (game.bookmakers || []).map(bk => ({
        name: bk.title,
        lastUpdate: bk.last_update,
        markets: (bk.markets || []).map(mkt => ({
          key: mkt.key,
          outcomes: mkt.outcomes.map(o => ({
            name: o.name,
            price: o.price,
            point: o.point,
            description: o.description || ''
          }))
        }))
      }))
    }))
  };
}

// Player props — the good stuff
// Available markets:
//   player_points, player_rebounds, player_assists,
//   player_threes, player_blocks, player_steals,
//   player_points_rebounds_assists, player_points_rebounds,
//   player_points_assists, player_rebounds_assists,
//   player_double_double, player_triple_double
const PROP_MARKETS = [
  'player_points',
  'player_rebounds',
  'player_assists',
  'player_threes',
  'player_blocks',
  'player_steals',
  'player_points_rebounds_assists',
  'player_double_double',
  'player_triple_double',
  'player_turnovers'
];

export async function getPlayerProps(eventId = null) {
  const key = getKey();
  if (!key) return { error: 'No ODDS_API_KEY', data: [] };

  // If we have a specific event, get props for that event
  if (eventId) {
    return await getEventProps(eventId);
  }

  // Otherwise get all upcoming events first
  const eventsUrl = `${BASE}/sports/${SPORT}/events/?apiKey=${key}`;
  const events = await safeFetch(eventsUrl, 'events');
  if (!events || !events.length) return { error: null, data: [] };

  // Get props for each upcoming event (limit to save API calls)
  const upcoming = events
    .filter(e => new Date(e.commence_time) > new Date())
    .slice(0, 3);

  const allProps = [];
  for (const event of upcoming) {
    const result = await getEventProps(event.id);
    if (result.data) {
      allProps.push({
        eventId: event.id,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        startTime: event.commence_time,
        props: result.data
      });
    }
  }

  return { error: null, data: allProps };
}

async function getEventProps(eventId) {
  const key = getKey();
  const markets = PROP_MARKETS.join(',');
  const url = `${BASE}/sports/${SPORT}/events/${eventId}/odds?apiKey=${key}&regions=us&markets=${markets}&oddsFormat=american`;
  const data = await safeFetch(url, `props-${eventId}`);

  if (!data) return { error: 'Failed', data: null };

  // Parse into a clean player-centric structure
  const playerMap = {};

  for (const bk of data.bookmakers || []) {
    for (const mkt of bk.markets || []) {
      for (const outcome of mkt.outcomes || []) {
        const playerName = outcome.description || outcome.name;
        if (!playerName) continue;

        // Determine stat type from market key
        const statMap = {
          'player_points': 'PTS',
          'player_rebounds': 'REB',
          'player_assists': 'AST',
          'player_threes': '3PM',
          'player_blocks': 'BLK',
          'player_steals': 'STL',
          'player_points_rebounds_assists': 'PRA',
          'player_double_double': 'Double-Double',
          'player_triple_double': 'Triple-Double',
          'player_turnovers': 'TO',
          'player_points_rebounds': 'PR',
          'player_points_assists': 'PA',
          'player_rebounds_assists': 'RA'
        };
        const stat = statMap[mkt.key] || mkt.key;

        if (!playerMap[playerName]) {
          playerMap[playerName] = { name: playerName, lines: {} };
        }

        const isBinary = mkt.key.includes('double_double') || mkt.key.includes('triple_double');
        const lineVal = isBinary ? 0.5 : outcome.point;
        const lineKey = `${stat}_${lineVal}`;
        if (!playerMap[playerName].lines[lineKey]) {
          playerMap[playerName].lines[lineKey] = {
            stat,
            line: lineVal,
            books: []
          };
        }

        playerMap[playerName].lines[lineKey].books.push({
          book: bk.title,
          side: outcome.name, // "Over" or "Under"
          odds: outcome.price,
          lastUpdate: bk.last_update
        });
      }
    }
  }

  // Flatten into array
  const players = Object.values(playerMap).map(p => ({
    name: p.name,
    lines: Object.values(p.lines).map(l => {
      // DD/TD use Yes/No instead of Over/Under
      const over = l.books.find(b => b.side === 'Over' || b.side === 'Yes');
      const under = l.books.find(b => b.side === 'Under' || b.side === 'No');
      // Get best odds across books
      const overBooks = l.books.filter(b => b.side === 'Over' || b.side === 'Yes');
      const underBooks = l.books.filter(b => b.side === 'Under' || b.side === 'No');
      const bestOver = overBooks.length ? overBooks.reduce((best, b) => b.odds > best.odds ? b : best) : null;
      const bestUnder = underBooks.length ? underBooks.reduce((best, b) => b.odds > best.odds ? b : best) : null;

      return {
        stat: l.stat,
        line: l.line,
        over: over ? { odds: over.odds, book: over.book } : null,
        under: under ? { odds: under.odds, book: under.book } : null,
        bestOver: bestOver ? { odds: bestOver.odds, book: bestOver.book } : null,
        bestUnder: bestUnder ? { odds: bestUnder.odds, book: bestUnder.book } : null,
        allBooks: l.books
      };
    })
  }));

  return { error: null, data: players };
}

// Backward compat
export async function getOdds(markets) {
  return getGameOdds(markets);
}

export async function getLiveOdds() {
  const key = getKey();
  if (!key) return { error: 'No ODDS_API_KEY', data: [] };
  const url = `${BASE}/sports/${SPORT}/odds-live/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  const data = await safeFetch(url, 'live-odds');
  if (!data || !Array.isArray(data)) return { error: null, data: [] };
  return { error: null, data };
}

export async function getScores() {
  const key = getKey();
  if (!key) return { error: 'No ODDS_API_KEY', data: [] };
  const url = `${BASE}/sports/${SPORT}/scores/?apiKey=${key}&daysFrom=1`;
  const data = await safeFetch(url, 'scores');
  if (!data) return { error: 'Failed', data: [] };
  return {
    error: null,
    data: data.map(g => ({
      id: g.id, homeTeam: g.home_team, awayTeam: g.away_team,
      startTime: g.commence_time, completed: g.completed, scores: g.scores
    }))
  };
}

export async function getEvents() {
  const key = getKey();
  if (!key) return { error: 'No ODDS_API_KEY', data: [] };
  const url = `${BASE}/sports/${SPORT}/events/?apiKey=${key}`;
  const data = await safeFetch(url, 'events');
  if (!data) return { error: 'Failed', data: [] };
  return { error: null, data };
}

export default { isConfigured, getGameOdds, getPlayerProps, getEventProps, getOdds, getLiveOdds, getScores, getEvents };
