// Polymarket API — free, no key required
// Championship futures + any NBA event markets

const BASE = 'https://gamma-api.polymarket.com';

async function safeFetch(url, label) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[POLY:${label}] ${e.message}`);
    return null;
  }
}

export async function getChampionshipOdds() {
  const data = await safeFetch(`${BASE}/events?slug=2026-nba-champion`, 'champion');
  if (!data?.[0]?.markets) return [];

  const event = data[0];
  const markets = event.markets || [];

  return markets
    .map(m => {
      const prices = JSON.parse(m.outcomePrices || '["0","0"]');
      const yes = parseFloat(prices[0]);
      if (yes < 0.005) return null;

      const team = (m.question || '')
        .replace('Will the ', '')
        .replace(' win the 2026 NBA Finals?', '')
        .trim();

      const american = yes > 0.5
        ? Math.round(-100 * yes / (1 - yes))
        : Math.round(100 * (1 - yes) / yes);

      return {
        team,
        prob: +(yes * 100).toFixed(1),
        odds: american > 0 ? `+${american}` : `${american}`,
        volume: parseFloat(m.volume || 0),
        slug: m.market_slug || ''
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.prob - a.prob);
}

export async function getNBAEvents() {
  // Search for all NBA-related events
  const slugs = [
    '2026-nba-champion',
    '2026-nba-mvp',
    '2026-nba-finals-mvp',
    'nba-finals-2026',
    '2026-nba-eastern-conference-champion',
    '2026-nba-western-conference-champion'
  ];

  const results = await Promise.allSettled(
    slugs.map(slug => safeFetch(`${BASE}/events?slug=${slug}`, slug))
  );

  const events = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.[0]) continue;
    const e = r.value[0];
    const markets = (e.markets || [])
      .map(m => {
        const prices = JSON.parse(m.outcomePrices || '["0","0"]');
        const yes = parseFloat(prices[0]);
        if (yes < 0.005) return null;
        return {
          question: m.question || '',
          prob: +(yes * 100).toFixed(1),
          odds: yes > 0.5 ? Math.round(-100 * yes / (1 - yes)) : Math.round(100 * (1 - yes) / yes),
          volume: parseFloat(m.volume || 0)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.prob - a.prob);

    if (markets.length) {
      events.push({
        title: e.title,
        slug: e.slug,
        volume: parseFloat(e.volume || 0),
        markets: markets.slice(0, 15)
      });
    }
  }

  return events;
}

export default { getChampionshipOdds, getNBAEvents };
