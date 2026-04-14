// JSON file-based persistent storage for users and betting slips
// Works on Railway with persistent volume at /data

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', '..', 'data');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = join(DATA_DIR, 'users.json');
const SLIPS_FILE = join(DATA_DIR, 'slips.json');

function loadJSON(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`[STORE] Failed to load ${file}:`, e.message);
  }
  return fallback;
}

function saveJSON(file, data) {
  try {
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[STORE] Failed to save ${file}:`, e.message);
  }
}

// Users
let users = loadJSON(USERS_FILE, {});

export function createUser(username) {
  const name = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name || name.length < 2 || name.length > 20) {
    return { error: 'Username must be 2-20 chars, letters/numbers/dashes only' };
  }
  if (users[name]) {
    return { error: 'Username taken', existing: true };
  }
  users[name] = {
    name,
    displayName: username.trim(),
    createdAt: new Date().toISOString(),
    record: { wins: 0, losses: 0, pushes: 0 },
    bankroll: 1000
  };
  saveJSON(USERS_FILE, users);
  return { user: users[name] };
}

export function getUser(username) {
  const name = username.trim().toLowerCase();
  return users[name] || null;
}

export function loginUser(username) {
  const name = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (users[name]) return { user: users[name] };
  return createUser(username);
}

export function getLeaderboard() {
  return Object.values(users)
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

// Slips
let slips = loadJSON(SLIPS_FILE, []);

export function createSlip({ user, legs, wager, gameDate }) {
  const u = getUser(user);
  if (!u) return { error: 'User not found' };
  if (!legs?.length) return { error: 'Need at least one leg' };
  if (wager < 1 || wager > 10000) return { error: 'Wager must be $1-$10,000' };

  // Calculate parlay odds
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

  slips.unshift(slip);
  saveJSON(SLIPS_FILE, slips);
  return { slip };
}

export function getSlips({ status, user, limit = 50 } = {}) {
  let filtered = slips;
  if (status) filtered = filtered.filter(s => s.status === status);
  if (user) filtered = filtered.filter(s => s.userKey === user.toLowerCase());
  return filtered.slice(0, limit);
}

export function getSlip(id) {
  return slips.find(s => s.id === id) || null;
}

export function gradeSlip(id, results) {
  const slip = slips.find(s => s.id === id);
  if (!slip) return { error: 'Slip not found' };
  if (slip.status !== 'active') return { error: 'Slip already graded' };

  // results is an array of 'won'|'lost'|'push' for each leg
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
    // Credit the user
    const u = users[slip.userKey];
    if (u) {
      u.bankroll += slip.payout - slip.wager;
      u.record.wins++;
      saveJSON(USERS_FILE, users);
    }
  } else {
    // Has pushes but no losses
    slip.status = 'won';
    slip.result = 'won';
  }

  if (slip.status === 'lost') {
    const u = users[slip.userKey];
    if (u) {
      u.bankroll -= slip.wager;
      u.record.losses++;
      saveJSON(USERS_FILE, users);
    }
  }

  saveJSON(SLIPS_FILE, slips);
  return { slip };
}

export function deleteSlip(id, userKey) {
  const idx = slips.findIndex(s => s.id === id && s.userKey === userKey);
  if (idx === -1) return { error: 'Not found or not yours' };
  if (slips[idx].status !== 'active') return { error: 'Can only delete active slips' };
  slips.splice(idx, 1);
  saveJSON(SLIPS_FILE, slips);
  return { ok: true };
}

export default {
  createUser, getUser, loginUser, getLeaderboard,
  createSlip, getSlips, getSlip, gradeSlip, deleteSlip
};
