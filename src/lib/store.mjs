// Persistent storage for users and betting slips
// Uses Upstash Redis when UPSTASH_REDIS_REST_URL is set (Vercel/production)
// Falls back to JSON files for local dev

import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'crypto';

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

function generateToken() {
  return randomBytes(32).toString('hex');
}

// --- Storage backend ---
let backend;

async function initBackend() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
    console.log('[STORE] Using Upstash Redis');
    backend = {
      async get(key) {
        const val = await redis.get(key);
        return val;
      },
      async set(key, val) {
        await redis.set(key, JSON.stringify(val));
      },
      async lpush(key, val) {
        await redis.lpush(key, JSON.stringify(val));
      },
      async lrange(key, start, end) {
        const items = await redis.lrange(key, start, end);
        return items.map(i => typeof i === 'string' ? JSON.parse(i) : i);
      },
      async llen(key) {
        return await redis.llen(key);
      },
      async lset(key, index, val) {
        await redis.lset(key, index, JSON.stringify(val));
      },
      async hget(key, field) {
        const val = await redis.hget(key, field);
        return val ? (typeof val === 'string' ? JSON.parse(val) : val) : null;
      },
      async hset(key, field, val) {
        await redis.hset(key, { [field]: JSON.stringify(val) });
      },
      async hgetall(key) {
        const all = await redis.hgetall(key);
        if (!all) return {};
        const out = {};
        for (const [k, v] of Object.entries(all)) {
          out[k] = typeof v === 'string' ? JSON.parse(v) : v;
        }
        return out;
      },
      type: 'redis'
    };
  } else if (process.env.VERCEL) {
    // Vercel serverless — in-memory only (no filesystem writes)
    // Data won't persist across cold starts without Redis
    console.log('[STORE] Using in-memory store (Vercel without Redis — set UPSTASH vars for persistence)');
    let usersData = {};
    let slipsData = [];
    backend = {
      async hget(key, field) { return usersData[field] || null; },
      async hset(key, field, val) { usersData[field] = val; },
      async hgetall(key) { return usersData; },
      async lpush(key, val) { slipsData.unshift(val); },
      async lrange(key, start, end) { return slipsData.slice(start, end === -1 ? undefined : end + 1); },
      async llen(key) { return slipsData.length; },
      async lset(key, index, val) { slipsData[index] = val; },
      type: 'memory'
    };
  } else {
    // Local JSON file fallback
    const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');
    try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}

    const USERS_FILE = join(DATA_DIR, 'users.json');
    const SLIPS_FILE = join(DATA_DIR, 'slips.json');

    const loadJSON = (file, fb) => {
      try { if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8')); } catch {}
      return fb;
    };

    let usersData = loadJSON(USERS_FILE, {});
    let slipsData = loadJSON(SLIPS_FILE, []);

    console.log('[STORE] Using local JSON files');
    backend = {
      async hget(key, field) { return usersData[field] || null; },
      async hset(key, field, val) { usersData[field] = val; writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2)); },
      async hgetall(key) { return usersData; },
      async lpush(key, val) { slipsData.unshift(val); writeFileSync(SLIPS_FILE, JSON.stringify(slipsData, null, 2)); },
      async lrange(key, start, end) { return slipsData.slice(start, end === -1 ? undefined : end + 1); },
      async llen(key) { return slipsData.length; },
      async lset(key, index, val) { slipsData[index] = val; writeFileSync(SLIPS_FILE, JSON.stringify(slipsData, null, 2)); },
      // Expose for grading
      _getSlips: () => slipsData,
      _saveSlips: () => writeFileSync(SLIPS_FILE, JSON.stringify(slipsData, null, 2)),
      type: 'json'
    };
  }
}

await initBackend();

// --- Users ---

export async function createUser(username, password) {
  const name = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name || name.length < 2 || name.length > 20) {
    return { error: 'Username must be 2-20 chars, letters/numbers/dashes only' };
  }
  if (!password || password.length < 4) {
    return { error: 'Password must be at least 4 characters' };
  }
  const existing = await backend.hget('users', name);
  if (existing) {
    return { error: 'Username taken' };
  }
  const token = generateToken();
  const user = {
    name,
    displayName: username.trim(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    record: { wins: 0, losses: 0, pushes: 0 },
    bankroll: 1000,
    token
  };
  await backend.hset('users', name, user);
  return { user: sanitizeUser(user), token };
}

export async function getUser(username) {
  const name = username.trim().toLowerCase();
  const user = await backend.hget('users', name);
  return user ? sanitizeUser(user) : null;
}

export async function getUserFull(username) {
  const name = username.trim().toLowerCase();
  return await backend.hget('users', name);
}

export async function loginUser(username, password) {
  const name = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const existing = await backend.hget('users', name);
  if (!existing) {
    return { error: 'User not found. Sign up first.' };
  }
  // Legacy users without password (auto-migrate)
  if (!existing.passwordHash) {
    if (!password || password.length < 4) return { error: 'Set a password (4+ chars) to claim this account' };
    existing.passwordHash = hashPassword(password);
    existing.token = generateToken();
    await backend.hset('users', name, existing);
    return { user: sanitizeUser(existing), token: existing.token };
  }
  if (!password || !verifyPassword(password, existing.passwordHash)) {
    return { error: 'Wrong password' };
  }
  // Keep existing token — don't rotate, so multiple devices stay logged in
  if (!existing.token) {
    existing.token = generateToken();
    await backend.hset('users', name, existing);
  }
  return { user: sanitizeUser(existing), token: existing.token };
}

export async function verifyToken(token) {
  if (!token) return null;
  const all = await backend.hgetall('users');
  for (const user of Object.values(all)) {
    if (user.token === token) return sanitizeUser(user);
  }
  return null;
}

// Strip sensitive fields before sending to client
function sanitizeUser(user) {
  const { passwordHash, token, ...safe } = user;
  return safe;
}

export async function getLeaderboard() {
  const all = await backend.hgetall('users');
  return Object.values(all)
    .map(u => ({
      name: u.displayName,
      wins: u.record.wins,
      losses: u.record.losses,
      pushes: u.record.pushes,
      total: u.record.wins + u.record.losses + u.record.pushes,
      winPct: (u.record.wins + u.record.losses) > 0
        ? (u.record.wins / (u.record.wins + u.record.losses) * 100).toFixed(1)
        : '0.0',
      bankroll: u.bankroll
    }))
    .sort((a, b) => b.bankroll - a.bankroll);
}

// --- Slips ---

export async function createSlip({ user, legs, wager, gameDate }) {
  const u = await getUser(user);
  if (!u) return { error: 'User not found' };
  if (!legs?.length) return { error: 'Need at least one leg' };
  if (wager < 1 || wager > 10000) return { error: 'Wager must be $1-$10,000' };

  let decimalOdds = 1;
  for (const leg of legs) {
    const american = leg.odds || -110;
    const dec = american > 0 ? (american / 100) + 1 : (100 / Math.abs(american)) + 1;
    decimalOdds *= dec;
    leg.decimalOdds = +dec.toFixed(3);
  }

  const payout = +(wager * decimalOdds).toFixed(2);
  const americanTotal = decimalOdds >= 2
    ? `+${Math.round((decimalOdds - 1) * 100)}`
    : `-${Math.round(100 / (decimalOdds - 1))}`;

  const slip = {
    id: randomUUID().slice(0, 8),
    user: u.displayName,
    userKey: u.name,
    createdAt: new Date().toISOString(),
    gameDate: gameDate || null,
    legs: legs.map(l => ({
      type: l.type || 'prop',
      game: l.game || '',
      gameId: l.gameId || '',
      player: l.player || '',
      stat: l.stat || '',
      line: l.line ?? 0,
      pick: l.pick || '',
      odds: l.odds || -110,
      result: null
    })),
    totalOdds: americanTotal,
    decimalOdds: +decimalOdds.toFixed(3),
    wager,
    payout,
    status: 'active',
    result: null
  };

  await backend.lpush('slips', slip);
  return { slip };
}

export async function getSlips({ status, user, limit = 50 } = {}) {
  const all = await backend.lrange('slips', 0, 200);
  let filtered = all.filter(s => s.status !== 'deleted'); // always hide deleted
  if (status) filtered = filtered.filter(s => s.status === status);
  if (user) filtered = filtered.filter(s => s.userKey === user.toLowerCase());
  return filtered.slice(0, limit);
}

export async function getSlip(id) {
  const all = await backend.lrange('slips', 0, 200);
  return all.find(s => s.id === id) || null;
}

export async function gradeSlip(id, results) {
  const all = await backend.lrange('slips', 0, 200);
  const idx = all.findIndex(s => s.id === id);
  if (idx === -1) return { error: 'Slip not found' };
  const slip = all[idx];
  if (slip.status !== 'active') return { error: 'Slip already graded' };

  let allWon = true;
  let anyLost = false;
  slip.legs.forEach((leg, i) => {
    leg.result = results[i] || 'pending';
    if (leg.result === 'lost') { allWon = false; anyLost = true; }
    if (leg.result !== 'won') allWon = false;
  });

  if (anyLost) {
    slip.status = 'lost';
    slip.result = 'lost';
  } else if (allWon) {
    slip.status = 'won';
    slip.result = 'won';
  }

  // Update user record
  const u = await getUser(slip.userKey);
  if (u) {
    if (slip.status === 'won') {
      u.bankroll += slip.payout - slip.wager;
      u.record.wins++;
    } else if (slip.status === 'lost') {
      u.bankroll -= slip.wager;
      u.record.losses++;
    }
    await backend.hset('users', u.name, u);
  }

  await backend.lset('slips', idx, slip);
  return { slip };
}

export async function deleteSlip(id, userKey) {
  const all = await backend.lrange('slips', 0, 200);
  const idx = all.findIndex(s => s.id === id && s.userKey === userKey);
  if (idx === -1) return { error: 'Not found or not yours' };
  if (all[idx].status !== 'active') return { error: 'Can only delete active slips' };
  // Redis doesn't have lremove by index easily — mark as deleted
  all[idx].status = 'deleted';
  await backend.lset('slips', idx, all[idx]);
  return { ok: true };
}

export async function adminDeleteUserSlips(userKey) {
  const all = await backend.lrange('slips', 0, 500);
  let removed = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i].userKey === userKey || all[i].user === userKey) {
      all[i].status = 'deleted';
      await backend.lset('slips', i, all[i]);
      removed++;
    }
  }
  return removed;
}

export async function adminResetUser(userKey) {
  const user = await backend.hget('users', userKey);
  if (!user) return false;
  user.bankroll = 1000;
  user.record = { wins: 0, losses: 0, pushes: 0 };
  await backend.hset('users', userKey, user);
  return true;
}

export default {
  createUser, getUser, getUserFull, loginUser, verifyToken, getLeaderboard,
  createSlip, getSlips, getSlip, gradeSlip, deleteSlip,
  adminDeleteUserSlips, adminResetUser
};
