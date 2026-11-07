// Готовая аналитика для игры: KPI, влияние событий, этапы, корреляции, автоматические выводы (ru/en).
import { addDays, day, nowIso } from './lib.mjs';

const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function windowAvg(map, from, to) { const v = []; for (let d = from; d <= to; d = addDays(d, 1)) if (map.has(d) && map.get(d) != null) v.push(map.get(d)); return avg(v); }
function impact(e, map, win = 7) {
  const s = e.date_start, end = e.date_end && e.date_end > s ? e.date_end : addDays(s, win - 1);
  const b = windowAvg(map, addDays(s, -win), addDays(s, -1));
  const du = windowAvg(map, s, end), af = windowAvg(map, addDays(end, 1), addDays(end, win));
  const pct = x => (x != null && b ? Math.round(((x - b) / b) * 1000) / 10 : null);
  return [pct(du), pct(af)];
}
function pearson(xs, ys) {
  const n = xs.length; if (n < 10) return null;
  const mx = avg(xs), my = avg(ys); let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; b += dx * dx; c += dy * dy; }
  return b && c ? Math.round((a / Math.sqrt(b * c)) * 100) / 100 : null;
}

export function analytics(store) {
  const P = store.read('platform.json'), E = store.read('events.json'), L = store.read('live.json'), S = store.read('sboxgame.json'), K = store.read('skins.json'), PK = store.read('packages.json');
  if (!P) throw new Error('нет истории платформы');
  const today = day(Date.now());
  const C = P.daily.cols, rows = P.daily.rows.filter(r => r[0] < today);
  const col = n => C.indexOf(n);
  const series = n => new Map(rows.map(r => [r[0], r[col(n)]]));
  const ccu = series('ccuPeak'), dau = series('users'), nu = series('newUsers'), pt = series('playtimeSec');
  const rev = new Map(Object.entries(S?.skinRevenue || {}));
  const out = { generatedAt: nowIso() };

  // KPI
  const last30 = rows.slice(-30), prev30 = rows.slice(-60, -30);
  const ath = rows.reduce((a, r) => (r[col('ccuPeak')] > a[col('ccuPeak')] ? r : a));
  const athDau = rows.reduce((a, r) => (r[col('users')] > a[col('users')] ? r : a));
  out.kpi = {
    dau30: Math.round(avg(last30.map(r => r[col('users')]))), dau30prev: Math.round(avg(prev30.map(r => r[col('users')]))),
    newUsers30: last30.reduce((s, r) => s + r[col('newUsers')], 0),
    totalPlayers: rows.reduce((s, r) => s + r[col('newUsers')], 0), totalHours: Math.round(rows.reduce((s, r) => s + r[col('playtimeSec')], 0) / 3600),
    athCcu: { value: ath[col('ccuPeak')], date: ath[0] }, athDau: { value: athDau[col('users')], date: athDau[0] },
    avgSessionMin30: Math.round((last30.reduce((s, r) => s + r[col('playtimeSec')], 0) / Math.max(1, last30.reduce((s, r) => s + r[col('sessions')], 0)) / 60) * 10) / 10,
    games: PK?.total ?? null, gamesLive: L?.topNow?.rows?.length ?? null, playersInGames: L?.topNow?.rows?.reduce((s, r) => s + r[3], 0) ?? null,
    skinRevenue30: Math.round([...rev.entries()].filter(([d]) => d >= addDays(today, -30) && d < today).reduce((s, [, v]) => s + v, 0)),
    skinsTracked: K?.total ?? null
  };

  // Влияние событий (только значимые типы)
  const evs = (E?.events || []).filter(e => ['release', 'beta', 'steam', 'price', 'free', 'jam', 'platform', 'skin'].includes(e.type) && e.date_start < today && e.date_start > '2021-04-13');
  out.eventImpact = {
    cols: ['key', 'date', 'type', 'title', 'dCcu', 'dDau', 'dNew', 'dHours', 'dSkinRevenue', 'dauAfter'],
    rows: evs.map(e => { const a = impact(e, ccu), b = impact(e, dau), c = impact(e, nu), d = impact(e, pt), r = impact(e, rev); return [e.key, e.date_start, e.type, e.title, a[0], b[0], c[0], d[0], r[0], b[1]]; })
  };

  // Корреляция выручки скинов и активности
  const xs = [], ys = [];
  for (const [d, v] of rev) if (dau.has(d) && d < today) { xs.push(v); ys.push(dau.get(d)); }
  out.correlation = { skinRevenueVsDau: pearson(xs, ys), days: xs.length };

  // Концентрация аудитории режимов
  if (PK?.games) {
    const ui = PK.games.cols.indexOf('users'), si = PK.games.cols.indexOf('seconds');
    const u = PK.games.rows.map(r => r[ui]).sort((a, b) => b - a), s = PK.games.rows.map(r => r[si]).sort((a, b) => b - a);
    const share = (arr, n) => Math.round((arr.slice(0, n).reduce((a, b) => a + b, 0) / Math.max(1, arr.reduce((a, b) => a + b, 0))) * 1000) / 10;
    out.modesConcentration = { top10UsersPct: share(u, 10), top10HoursPct: share(s, 10), medianUsers: u[Math.floor(u.length / 2)], under100: u.filter(x => x < 100).length };
  }

  // Автоматические выводы
  const k = out.kpi, fmt = n => (n == null ? '—' : Math.round(n).toLocaleString('ru-RU'));
  const rel = out.eventImpact.rows.find(r => r[0] === 'seed:steam-release');
  const free = out.eventImpact.rows.find(r => r[0] === 'seed:free-weekend');
  out.insights = {
    ru: [
      `Рекорд онлайна — ${fmt(k.athCcu.value)} (${k.athCcu.date}), рекорд DAU — ${fmt(k.athDau.value)} (${k.athDau.date}). Сейчас средний DAU ${fmt(k.dau30)} (${Math.round((k.dau30 / k.athDau.value) * 1000) / 10}% от рекорда).`,
      `За всё время в играх побывали ${fmt(k.totalPlayers)} игроков, наиграно ${fmt(k.totalHours)} ч.`,
      rel ? `Релиз в Steam: DAU ${rel[5] > 0 ? '+' : ''}${rel[5]}% за неделю, через неделю после — ${rel[9]}% к исходному уровню.` : null,
      free ? `Бесплатные выходные: новых игроков ${free[6] > 0 ? '+' : ''}${free[6]}%, после окончания DAU ${free[9]}%.` : null,
      out.correlation.skinRevenueVsDau != null ? `Связь выручки скинов с DAU: r = ${out.correlation.skinRevenueVsDau} по ${out.correlation.days} дням.` : null,
      out.modesConcentration ? `Топ-10 режимов собирают ${out.modesConcentration.top10HoursPct}% всего игрового времени; у ${fmt(out.modesConcentration.under100)} режимов меньше 100 игроков.` : null
    ].filter(Boolean),
    en: [
      `Peak concurrent players: ${k.athCcu.value} (${k.athCcu.date}); peak DAU: ${k.athDau.value} (${k.athDau.date}). Current 30-day DAU: ${k.dau30}.`,
      `${k.totalPlayers} players have played s&box games in total, ${k.totalHours} hours played.`,
      rel ? `Steam release: DAU ${rel[5]}% in the first week.` : null,
      free ? `Free weekend: new players ${free[6]}%.` : null,
      out.correlation.skinRevenueVsDau != null ? `Skin revenue vs DAU correlation: r = ${out.correlation.skinRevenueVsDau}.` : null,
      out.modesConcentration ? `Top 10 games hold ${out.modesConcentration.top10HoursPct}% of all playtime.` : null
    ].filter(Boolean)
  };
  return out;
}
