// Источники данных. Каждая функция получает (store, prev) и возвращает объект для записи в файл.
import { http, pool, sleep, day, nowIso, addDays, table, money } from './lib.mjs';

const FP = 'https://public.facepunch.com/sbox';
const WATCH = 'https://sbox.watch';
const APP = 590830;

const bucket = b => [b.CcuPeak || 0, b.UniqueUsers || 0, b.NewUsers || 0, b.ReturningUsers || 0, b.Sessions || 0, b.PlaytimeSeconds || 0, b.EditorLoginUsers || 0];
const BUCKET_COLS = ['ccuPeak', 'users', 'newUsers', 'returningUsers', 'sessions', 'playtimeSec', 'editorUsers'];

// ---------------------------------------------------------------- живые данные (каждый запуск)
export async function live(store) {
  const out = { generatedAt: nowIso() };
  const errors = [];
  const tryDo = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); } };
  await tryDo('platform', async () => {
    const s = await http(`${FP}/stats/platform`);
    out.platform = { usersNow: s.UsersNow, editorNow: s.EditorUsersNow, peak24h: s.Peak24h, users24h: s.Users24h, users7d: s.Users7d, users30d: s.Users30d, sessions24h: s.Sessions24h, playtime24h: s.PlaytimeSeconds24h, at: s.Timestamp };
  });
  await tryDo('topNow', async () => {
    const r = await http(`${FP}/package/find/2?q=${encodeURIComponent('type:game sort:playersnow')}&take=100`);
    out.topNow = table(['ident', 'title', 'org', 'playersNow', 'users', 'thumb'],
      (r.Packages || []).filter(p => p.UsersNow > 0).map(p => [p.FullIdent, p.Title, p.Org?.Title, p.UsersNow, p.UsageStats?.Total?.Users || 0, p.Thumb]));
  });
  await tryDo('steam', async () => {
    const r = await http(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${APP}`);
    out.steamNow = r.response?.player_count ?? null;
  });
  await tryDo('watchTop', async () => {
    const r = await http(`${WATCH}/api/dashboard?kind=game&pageSize=100&page=1`, { timeout: 45000 });
    const items = r.packages || [];
    const thumb = t => { try { return t && t.startsWith('/') ? (new URL('https://sbox.watch' + t).searchParams.get('src') || 'https://sbox.watch' + t) : t; } catch { return t; } };
    out.watchTotals = r.totals || null;
    out.watchTop = table(['ident', 'title', 'org', 'playersNow', 'peak24h', 'momentum24h', 'weeklyPlaytimeSec', 'totalSec', 'score', 'playFund', 'users24h', 'thumb'],
      items.map(p => [p.ident, p.title, p.org, p.playersNow ?? null, p.playersPeak24h ?? null, p.change24h?.total ?? null,
        p.weeklyPlaytimeSeconds ?? null, p.totalSeconds ?? null, p.score ?? null, p.playFund?.state ?? null, p.usage24h?.users ?? null, thumb(p.thumb)]));
    if (!items.length) throw new Error('пустой список (формат изменился?) ключи: ' + Object.keys(r).join(','));
  });
  for (const range of ['24h', '7d']) {
    await tryDo('activity' + range, async () => {
      const r = await http(`${WATCH}/api/activity-history?range=${range}`);
      out['activity' + range] = (r.points || []).map(p => [p[0], Math.round(p[1] * 10) / 10]);
    });
  }
  if (!out.platform && !out.topNow) throw new Error(errors.join('; '));
  out.errors = errors;
  return out;
}

// ---------------------------------------------------------------- история платформы
export async function platform(store, prev) {
  const today = day(Date.now());
  const old = prev || { daily: table(['date', ...BUCKET_COLS], []), hourly: table(['ts', ...BUCKET_COLS], []) };
  const dmap = new Map(old.daily.rows.map(r => [r[0], r]));
  let from = dmap.size ? addDays([...dmap.keys()].sort().pop(), -3) : '2021-01-01';
  while (from <= today) {
    let to = addDays(from, 360); if (to > addDays(today, 1)) to = addDays(today, 1);
    const r = await http(`${FP}/stats/platform/history?from=${from}T00:00:00Z&to=${to}T00:00:00Z&interval=day`, { timeout: 60000 });
    (r.Data || []).forEach(b => dmap.set(b.Timestamp.slice(0, 10), [b.Timestamp.slice(0, 10), ...bucket(b)]));
    if (to > today) break; from = to;
  }
  const hFrom = addDays(today, -30);
  const h = await http(`${FP}/stats/platform/history?from=${hFrom}T00:00:00Z&to=${addDays(today, 1)}T00:00:00Z&interval=hour`, { timeout: 60000 });
  const hourly = (h.Data || []).map(b => [b.Timestamp.slice(0, 13) + ':00Z', ...bucket(b)]);
  const daily = [...dmap.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // Проверка: история не должна «укорачиваться»
  if (old.daily.rows.length && daily.length < old.daily.rows.length) throw new Error('история платформы стала короче — оставляем прежнюю');

  // Удержание: релиз, бесплатные выходные и когорта месяц назад
  const retention = {};
  for (const c of ['2026-04-28', '2026-10-03', addDays(today, -31), addDays(today, -8)]) {
    try {
      const r = await http(`${FP}/stats/platform/retention?cohort=${c}`);
      retention[c] = { users: r.Users || 0, days: (r.Days || []).slice(0, 31).map(d => +(d.Retention || 0).toFixed(4)) };
    } catch { if (prev?.retention?.[c]) retention[c] = prev.retention[c]; }
  }
  return { generatedAt: nowIso(), daily: table(['date', ...BUCKET_COLS], daily), hourly: table(['ts', ...BUCKET_COLS], hourly), retention };
}

// ---------------------------------------------------------------- Steam
export async function steam(store, prev) {
  const out = { generatedAt: nowIso(), ccu: prev?.ccu || [], reviewsWeekly: prev?.reviewsWeekly || [], reviewsDaily: prev?.reviewsDaily || [], summary: prev?.summary || null };
  try {
    const pts = await http(`https://steamcharts.com/app/${APP}/chart-data.json`, { timeout: 45000 });
    if (Array.isArray(pts) && pts.length) out.ccu = pts;
  } catch (e) { out.ccuError = e.message; }
  const h = await http(`https://store.steampowered.com/appreviewhistogram/${APP}?l=english&review_score_preference=0`);
  out.reviewsWeekly = (h.results?.rollups || []).map(r => [day(r.date * 1000), r.recommendations_up, r.recommendations_down]);
  out.reviewsDaily = (h.results?.recent || []).map(r => [day(r.date * 1000), r.recommendations_up, r.recommendations_down]);
  try {
    const s = await http(`https://store.steampowered.com/appreviews/${APP}?json=1&language=all&purchase_type=all&num_per_page=0`);
    if (s.query_summary) out.summary = { total: s.query_summary.total_reviews, positive: s.query_summary.total_positive, desc: s.query_summary.review_score_desc };
  } catch { /* оставляем прежнее */ }
  return out;
}

// ---------------------------------------------------------------- каталог режимов
export async function packages() {
  const all = [];
  let skip = 0, total = Infinity;
  while (skip < total) {
    const r = await http(`${FP}/package/find/2?q=${encodeURIComponent('type:game sort:newest')}&take=100&skip=${skip}`, { timeout: 45000 });
    total = r.TotalCount || 0;
    const list = r.Packages || [];
    if (!list.length) break;
    all.push(...list); skip += list.length;
  }
  if (all.length < 100) throw new Error(`слишком мало режимов (${all.length})`);
  return {
    generatedAt: nowIso(), total: all.length,
    games: table(['ident', 'title', 'org', 'created', 'updated', 'tags', 'users', 'sessions', 'seconds', 'playersNow', 'up', 'down', 'favourited', 'thumb'],
      all.map(p => [p.FullIdent, p.Title, p.Org?.Title, (p.Created || '').slice(0, 10), (p.Updated || '').slice(0, 10), (p.Tags || []).join(','),
        p.UsageStats?.Total?.Users || 0, p.UsageStats?.Total?.Sessions || 0, p.UsageStats?.Total?.Seconds || 0, p.UsersNow || 0,
        p.VotesUp || 0, p.VotesDown || 0, p.Favourited || 0, p.Thumb]))
  };
}

// ---------------------------------------------------------------- события: базовые + джемы + новости
export async function events(store, prev, seeds) {
  const list = seeds.map(e => ({ ...e, auto: 0 }));
  const jams = await http(`${FP}/jam`);
  const jamOut = [];
  for (const j of jams) {
    const d = s => (s ? s.slice(0, 10) : null);
    const winners = (j.Categories || []).map(c => c.Winner).filter(Boolean);
    jamOut.push({ ident: j.Ident, title: j.Title, theme: j.Theme, prize: j.PrizePool, starts: d(j.Starts), deadline: d(j.Deadline), finals: d(j.FinalsStart || j.GrandFinal), results: d(j.Results), entries: j.EntryCount || 0, winners, url: j.Url });
    if (j.Announced) list.push({ key: `jam:${j.Ident}:announce`, date_start: d(j.Announced), type: 'jam', title: `${j.Title}: анонс`, title_en: `${j.Title}: announced`, url: j.Url, auto: 1 });
    if (j.Starts) list.push({ key: `jam:${j.Ident}:dev`, date_start: d(j.Starts), date_end: d(j.Deadline), type: 'jam', title: `${j.Title}: разработка`, title_en: `${j.Title}: development`, description: `Тема «${j.Theme || '—'}», работ: ${j.EntryCount || 0}, фонд ${j.PrizePool || '—'}`, description_en: `Theme "${j.Theme || '—'}", ${j.EntryCount || 0} entries, prize pool ${j.PrizePool || '—'}`, url: j.Url, auto: 1 });
    if (j.FinalsStart || j.GrandFinal) list.push({ key: `jam:${j.Ident}:finals`, date_start: d(j.FinalsStart || j.GrandFinal), date_end: d(j.Results || j.GrandFinal), type: 'jam', title: `${j.Title}: финал`, title_en: `${j.Title}: finals`, url: j.Url, auto: 1 });
  }
  const news = [];
  for (let skip = 0; skip < 2000; skip += 50) {
    const page = await http(`${FP}/news/platform?take=50&skip=${skip}`, { timeout: 60000 });
    if (!Array.isArray(page) || !page.length) break;
    news.push(...page); if (page.length < 50) break;
  }
  news.forEach(n => {
    const upd = /^(update|release|hotfix)/i.test(n.Title) || /\/news\/(update|release)-/.test(n.Url || '');
    list.push({ key: `news:${n.Id}`, date_start: n.Created.slice(0, 10), type: upd ? 'update' : 'news', title: n.Title, description: (n.Summary || '').slice(0, 300), url: n.Url ? 'https://sbox.game' + n.Url : null, auto: 1 });
  });
  list.sort((a, b) => (a.date_start < b.date_start ? -1 : 1));
  return { generatedAt: nowIso(), events: list, jams: jamOut };
}

// ---------------------------------------------------------------- аналитика режимов (sbox.watch)
export async function modes(store, prev, { limit = 60, rotate = 300, minUsers = 5 } = {}) {
  const live = store.read('live.json');
  const pk = store.read('packages.json');
  // Кого берём: топ по онлайну/пику (sbox.watch), плюс топ по игрокам за всё время
  const ids = new Set();
  live?.watchTop?.rows?.slice(0, 40).forEach(r => ids.add(r[0]));
  live?.topNow?.rows?.slice(0, 20).forEach(r => ids.add(r[0]));
  if (pk?.games) [...pk.games.rows].sort((a, b) => b[6] - a[6]).slice(0, 20).forEach(r => ids.add(r[0]));
  const top = [...ids].filter(Boolean).slice(0, limit);
  // Остальные игры каталога — по кругу, сначала самые давно обновлённые: так история собирается для всех игр, а не только для топа
  const prevIndex0 = prev?.modes || {};
  const age = id => (prevIndex0[id]?.generatedAt ? Date.parse(prevIndex0[id].generatedAt) : 0);
  const rest = (pk?.games?.rows || []).filter(r => r[0] && !ids.has(r[0]) && (r[6] || 0) >= minUsers).map(r => r[0])
    .sort((a, b) => age(a) - age(b)).slice(0, rotate);
  const list = [...top, ...rest];
  const index = {};
  let ok = 0;
  await pool(list, 4, async ident => {
    const a = await http(`${WATCH}/api/analytics/packages/game/${ident}`, { timeout: 45000 });
    const an = a.analytics || {};
    const ser = an.playerHistory?.series || {};
    const series = {};
    for (const [k, v] of Object.entries(ser)) series[k] = (v.points || []).map(p => [Date.parse(p.capturedAt), Math.round((p.players ?? 0) * 100) / 100]);
    const ins = (a.insights || an.insights || {});
    const out = {
      ident, title: a.package?.title, org: a.package?.org, thumb: a.package?.thumb, created: a.package?.created, updated: a.package?.updated,
      playersNow: a.package?.playersNow, peak24h: a.package?.playersPeak24h, totalUsers: a.package?.totalUsers, totalSeconds: a.package?.totalSeconds,
      weeklySeconds: a.package?.weeklyPlaytimeSeconds, score: a.package?.score, favorites: a.package?.favorites, up: a.package?.upvotes, down: a.package?.downvotes,
      playFund: a.package?.playFund?.state, tags: a.package?.tags,
      series, ranges: an.ranges || null, hourly: (an.hourly || []).map(h => [h.hour, Math.round((h.average || 0) * 100) / 100]),
      usage: an.usage || null, rank: an.rank || null, updateImpact: an.updateImpact || null,
      days: table(['date', 'players', 'new', 'returning', 'avgSessionMin'], (ins.days || []).map(d => [d.date, d.players, d.newPlayers, d.returningPlayers, d.averageSessionMinutes != null ? +d.averageSessionMinutes.toFixed(1) : null])),
      summary: ins.summary || null, generatedAt: nowIso()
    };
    store.write(`modes/${ident}.json`, out);
    index[ident] = { title: out.title, playersNow: out.playersNow, peak24h: out.peak24h, generatedAt: out.generatedAt };
    ok++;
    await sleep(150);
  });
  const prevIndex = prev?.modes || {};
  return { generatedAt: nowIso(), modes: { ...prevIndex, ...index }, updated: ok };
}

// ---------------------------------------------------------------- скины (sbox.dev)
// SvelteKit __data.json: «devalue»-формат — плоский массив, где объекты ссылаются на индексы
function devalue(data, idx) {
  const seen = new Map();
  const rec = i => {
    if (i === -1) return undefined; if (i === -2) return null; if (i === -3) return NaN; if (i === -4) return Infinity; if (i === -5) return -Infinity; if (i === -6) return -0;
    if (seen.has(i)) return seen.get(i);
    const v = data[i];
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && ['Date', 'Set', 'Map', 'BigInt', 'RegExp'].includes(v[0])) return v[0] === 'Date' ? v[1] : null;
      const arr = []; seen.set(i, arr); v.forEach(x => arr.push(rec(x))); return arr;
    }
    const o = {}; seen.set(i, o);
    for (const [k, x] of Object.entries(v)) o[k] = rec(x);
    return o;
  };
  return rec(idx);
}

export async function skins(store, prev) {
  const items = [];
  let total = Infinity;
  for (let page = 0; page < 30 && items.length < total; page++) {
    const r = await http(`https://sbox.dev/skins/__data.json?page=${page}`, { timeout: 45000 });
    const node = (r.nodes || []).find(n => n && n.type === 'data' && n.data && n.data[0] && n.data[0].skins !== undefined);
    if (!node) throw new Error('формат sbox.dev изменился');
    const root = devalue(node.data, 0);
    total = root.meta?.totalItems ?? items.length;
    const list = root.skins || [];
    if (!list.length) break;
    for (const s of list) if (!items.find(x => x.slug === s.slug)) items.push(s);
    if (root.meta?.lastPage) break;
    await sleep(500);
  }
  if (items.length < 50) throw new Error(`мало скинов (${items.length})`);
  // Накопление истории цен по дням (sbox.dev отдаёт текущую цену; историю храним сами, 365 дней)
  const hist = prev?.priceHistory || {};
  const today = day(Date.now());
  for (const s of items) {
    const h = (hist[s.slug] = hist[s.slug] || []);
    const row = [today, s.price ?? null, s.supplyOnMarket ?? null, s.soldPast24H ?? null];
    if (h.length && h[h.length - 1][0] === today) h[h.length - 1] = row; else h.push(row);
    if (h.length > 365) h.splice(0, h.length - 365);
  }
  return {
    generatedAt: nowIso(), total: items.length,
    skins: table(['slug', 'id', 'name', 'category', 'type', 'price', 'releasePrice', 'unitsSold', 'netRevenue', 'uniqueBuyers', 'refunded', 'drops', 'supply', 'onMarket', 'sold24h',
      'change24hPct', 'release', 'leavingAt', 'limited', 'activeInStore', 'owners', 'icon', 'marketUrl'],
      items.map(s => [s.slug, s.itemDefinitionId, s.name, s.category, s.itemDisplayName || s.itemType, s.price, s.releasePrice, s.unitsSold, s.netRevenue, s.uniqueBuyers,
        s.unitsRefunded, s.droppedUnits, s.totalSupply, s.supplyOnMarket, s.soldPast24H, s.priceChange24hPercent, s.release, s.leavingStoreAt || s.leavingAt,
        s.isLimitedSkin ? 1 : 0, s.isActiveStoreItem ? 1 : 0, s.uniqueOwners, s.iconUrl, s.marketUrl])),
    priceHistory: hist
  };
}

// ---------------------------------------------------------------- рынок Steam (запасной/дополнительный источник цен)
export async function market(store, prev) {
  const items = [];
  let start = 0, total = Infinity;
  while (start < total && start < 2000) {
    const r = await http(`https://steamcommunity.com/market/search/render/?appid=${APP}&norender=1&count=100&start=${start}&sort_column=name&sort_dir=asc&l=english&currency=1`, { timeout: 30000, retries: 4 });
    total = r.total_count || 0;
    const list = r.results || [];
    if (!list.length) break;
    items.push(...list); start += list.length;
    await sleep(2500);
  }
  if (!items.length) throw new Error('рынок пуст');
  const hist = prev?.history || {};
  const today = day(Date.now());
  for (const i of items) {
    const h = (hist[i.hash_name] = hist[i.hash_name] || []);
    const row = [today, i.sell_price != null ? i.sell_price / 100 : null, i.sell_listings];
    if (h.length && h[h.length - 1][0] === today) h[h.length - 1] = row; else h.push(row);
    if (h.length > 365) h.splice(0, h.length - 365);
  }
  return {
    generatedAt: nowIso(), total: items.length,
    items: table(['name', 'price', 'listings', 'icon'], items.map(i => [i.hash_name, i.sell_price != null ? i.sell_price / 100 : null, i.sell_listings,
      i.asset_description?.icon_url ? 'https://community.fastly.steamstatic.com/economy/image/' + i.asset_description.icon_url + '/96fx96f' : null])),
    history: hist
  };
}

export { devalue, money };

// ---------------------------------------------------------------- карточки скинов (sbox.dev API): цены, продажи на рынке Steam, стакан, владельцы
// Один файл на скин: skins/{id}.json. За запуск обновляется часть скинов (самые давно обновлённые), полный круг ~6 ч.
export async function skincards(store, prev, { perRun = 130 } = {}) {
  const sk = store.read('skins.json');
  if (!sk?.skins?.rows?.length) throw new Error('нет skins.json');
  const c = Object.fromEntries(sk.skins.cols.map((k, i) => [k, i]));
  const list = sk.skins.rows.map(r => ({ slug: r[c.slug], id: r[c.id], name: r[c.name] })).filter(x => x.slug && x.id);
  const index = { ...(prev?.skins || {}) };
  const todo = list.sort((a, b) => (index[a.id]?.at ? Date.parse(index[a.id].at) : 0) - (index[b.id]?.at ? Date.parse(index[b.id].at) : 0)).slice(0, perRun);
  const H = { Origin: 'https://sbox.dev', Referer: 'https://sbox.dev/' };
  const start = '2024-01-01T00:00:00.000Z', end = new Date().toISOString();
  const errors = [];
  await pool(todo, 4, async s => {
    try {
      const get = async u => (await http(u, { headers: H, timeout: 30000 }))?.data;
      const [pr, sa, ob, sup, det] = await Promise.all([
        get(`https://api.sbox.dev/v2/charts/${s.id}/prices?start=${start}&end=${end}&step=1d`),
        get(`https://api.sbox.dev/v2/charts/${s.id}/sales?start=${start}&end=${end}&step=1d`),
        get(`https://api.sbox.dev/v1/skins/${s.slug}/buy-sell-orders`).catch(() => null),
        get(`https://api.sbox.dev/v1/skins/${s.slug}/supply-sources`).catch(() => null),
        get(`https://api.sbox.dev/v1/skins/${s.slug}`).catch(() => null)
      ]);
      const d = t => String(t).slice(0, 10);
      const book = arr => (arr || []).slice(0, 25).map(o => [o.price, o.quantity]);
      const sum = arr => (arr || []).reduce((a, o) => a + (o.quantity || 0), 0);
      const out = {
        generatedAt: nowIso(), id: s.id, slug: s.slug, name: s.name,
        info: det ? { description: det.description, itemType: det.itemType, tradable: det.tradable ? 1 : 0, marketable: det.marketable ? 1 : 0,
          droppable: det.isDroppableItem ? 1 : 0, permanent: det.isPermanentStoreItem ? 1 : 0, owners: det.uniqueOwners, change24hPct: det.priceChange24hPercent,
          successfulSales: det.successfulSales, workshopId: det.workshopId, collection: det.collection } : null,
        // цена: лучшая заявка на продажу (sell) и на покупку (buy) по дням
        prices: table(['date', 'sell', 'buy'], (pr?.data || []).map(p => [d(p.t), p.s_P ?? null, p.b_P ?? null])),
        // продажи на рынке Steam: медианная цена и количество за день
        sales: table(['date', 'median', 'qty'], (sa?.data || []).map(p => [d(p.t), p.p ?? null, p.q ?? 0])),
        orders: ob ? { updatedAt: ob.lastUpdated, buy: book(ob.buyOrders), sell: book(ob.purchaseableItems), buyQty: sum(ob.buyOrders), sellQty: sum(ob.purchaseableItems),
          buyAllCost: ob.priceToBuyAllOnMarket, sellAllGet: ob.amountAfterSellAll } : null,
        supply: sup ? { owners: sup.trackedOwnerCount, trackedQty: sup.trackedQuantity, marketQty: sup.communityMarketQuantity, marketValue: sup.communityMarketValue,
          topHolders: (sup.topHolders || []).slice(0, 10).map(h => [h.profile?.isRedacted || h.profile?.isPrivate ? null : h.profile?.name, h.quantity, h.inventoryValueSharePercent]) } : null
      };
      store.write(`skins/${s.id}.json`, out);
      const last = out.sales.rows.at(-1);
      index[s.id] = { slug: s.slug, name: s.name, at: out.generatedAt, priceDays: out.prices.rows.length, salesDays: out.sales.rows.length, lastSale: last ? last[0] : null };
    } catch (e) { errors.push(`${s.slug}: ${e.message}`); }
    await sleep(250);
  });
  if (todo.length && errors.length === todo.length) throw new Error('все запросы к sbox.dev неудачны: ' + errors[0]);
  return { generatedAt: nowIso(), skins: index, errors: errors.slice(0, 20) };
}
