// Simple in-memory TTL cache
// Prevents redundant API calls on page reloads

const store = new Map();

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

export function has(key) {
  return get(key) !== null;
}

export function del(key) {
  store.delete(key);
}

export function clear() {
  store.clear();
}

export function stats() {
  let active = 0;
  let expired = 0;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expires) expired++;
    else active++;
  }
  return { active, expired, total: store.size };
}

// TTL presets (milliseconds)
export const TTL = {
  ROSTER: 30 * 60_000,      // 30 min — rosters don't change mid-game
  PLAYER_STATS: 30 * 60_000, // 30 min — season averages are stable
  PLAYER_GAMELOG: 60 * 60_000, // 1 hour — historical data
  TEAM_DETAIL: 15 * 60_000,  // 15 min — record can change after games
  TEAM_STATS: 15 * 60_000,   // 15 min
  GAME_ODDS: 30 * 60_000,    // 30 min — conserve Odds API quota (20K/month)
  PLAYER_PROPS: 30 * 60_000, // 30 min — conserve Odds API quota
  TEAMS_LIST: 60 * 60_000,   // 1 hour — team list never changes
  PROPS_MERGED: 3 * 60_000,  // 3 min — merged game props
};

export default { get, set, has, del, clear, stats, TTL };
