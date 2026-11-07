// Данные, которые есть только на страницах sbox.game (Blazor): выручка скинов по дням, продажи каждого скина,
// финансы Facepunch, Play Fund. Читаются настоящим Chromium (Playwright).
import { chromium } from 'playwright';
import { HELPERS, SKINS_OVERVIEW_SCRIPT, SKIN_PAGE_SCRIPT, FINANCE_SCRIPT, PLAYFUND_SCRIPT } from './page-scripts.mjs';
import { day, nowIso, money, table, sleep } from './lib.mjs';

const MONTHS = { January: '01', February: '02', March: '03', April: '04', May: '05', June: '06', July: '07', August: '08', September: '09', October: '10', November: '11', December: '12' };

async function openAndRun(ctx, url, readyExpr, script, timeout = 60000) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const t0 = Date.now();
    for (;;) {
      await page.evaluate(HELPERS);
      if (await page.evaluate(`(()=>{try{return !!(${readyExpr})}catch(e){return false}})()`)) break;
      if (Date.now() - t0 > timeout) throw new Error('страница не загрузилась: ' + url);
      await sleep(700);
    }
    await sleep(1500);
    await page.evaluate(HELPERS);
    return await page.evaluate(`(async()=>{${script}})()`);
  } finally { await page.close(); }
}

export async function sboxgame(store, prev, { skinPagesLimit = 60 } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: undefined, viewport: { width: 1400, height: 1000 } });
  const out = { generatedAt: nowIso(), errors: [] };
  try {
    // 1) Финансы
    try {
      const f = await openAndRun(ctx, 'https://sbox.game/metrics/finance', `document.body.innerText.includes('Monthly Finances') && __sx.charts().length > 0`, FINANCE_SCRIPT);
      const monthly = [];
      for (const cells of f.monthly || []) {
        const mm = String(cells[0] || '').match(/([A-Za-z]+)\s+(\d{4})/);
        if (!mm || !MONTHS[mm[1]]) continue;
        const month = `${mm[2]}-${MONTHS[mm[1]]}`;
        const row = { month, incomeGross: money(cells[1]) };
        const parse = (txt, prefix) => {
          const lines = String(txt || '').split(/\n/).map(s => s.trim()).filter(Boolean);
          if (lines.length) row[prefix] = money(lines[0]);
          const re = /([A-Za-z][A-Za-z ]*?)\s*[\t\n ]\s*(-?\$-?[\d.,]+[kKmMB]?)/g;
          let x; const j = lines.slice(1).join('\n');
          while ((x = re.exec(j))) row[`${prefix}:${x[1].trim()}`] = money(x[2]);
        };
        parse(cells[2], 'community'); parse(cells[3], 'profit');
        monthly.push(row);
      }
      const daily = {};
      (f.daily || []).forEach(s => (s.data || []).forEach(p => { (daily[day(p[0])] = daily[day(p[0])] || {})[s.name] = Math.round(p[1] * 100) / 100; }));
      if (!monthly.length) throw new Error('пустой баланс');
      out.finance = { monthly: monthly.sort((a, b) => (a.month < b.month ? -1 : 1)), daily };
    } catch (e) { out.errors.push('finance: ' + e.message); out.finance = prev?.finance; }

    // 2) Play Fund
    try {
      const pf = await openAndRun(ctx, 'https://sbox.game/metrics/playfund', `document.body.innerText.includes('Top Packages')`, PLAYFUND_SCRIPT);
      const conv = rows => rows.map((r, i) => [i + 1, r.href ? r.href.replace(/^\/|\/$/g, '').replace('/', '.') : null, r.cells[0], money(r.cells[3]), money(r.cells[4])]);
      out.playfund = { total: pf.total, top30d: table(['rank', 'ident', 'title', 'users', 'usd'], conv(pf.top['30d'] || [])), topAll: table(['rank', 'ident', 'title', 'users', 'usd'], conv(pf.top.All || [])) };
    } catch (e) { out.errors.push('playfund: ' + e.message); out.playfund = prev?.playfund; }

    // 3) Скины: обзор (выручка по дням, рейтинги)
    let ids = [];
    try {
      const ov = await openAndRun(ctx, 'https://sbox.game/metrics/skins', `document.body.innerText.includes('Top Skins') && __sx.charts().length > 0`, SKINS_OVERVIEW_SCRIPT, 90000);
      const rev = { ...(prev?.skinRevenue || {}) };
      (ov.revenue || []).forEach(p => { rev[day(p[0])] = Math.round(p[1] * 100) / 100; });
      out.skinRevenue = rev;
      const conv = rows => rows.map(r => [r.href ? r.href.split('/').pop() : null, r.cells[0], money(r.cells[1]), money(r.cells[2])]);
      out.skinTop = {};
      for (const [p, rows] of Object.entries(ov.top || {})) out.skinTop[p] = table(['id', 'name', 'units', 'usd'], conv(rows));
      out.skinDrops = {};
      for (const [p, rows] of Object.entries(ov.drops || {})) out.skinDrops[p] = table(['id', 'name', 'dropped', 'pct'], rows.map(r => [r.href ? r.href.split('/').pop() : null, r.cells[0], money(r.cells[1]), parseFloat(r.cells[2]) || null]));
      ids = ov.ids || [];
    } catch (e) { out.errors.push('skins overview: ' + e.message); out.skinRevenue = prev?.skinRevenue; out.skinTop = prev?.skinTop; out.skinDrops = prev?.skinDrops; }

    // 4) Продажи каждого скина по дням — по очереди, устаревшие (>24 ч) первыми
    const sbdev = store.read('skins.json');
    if (sbdev?.skins) { const ci = sbdev.skins.cols.indexOf('id'); sbdev.skins.rows.forEach(r => r[ci] && ids.push(String(r[ci]))); }
    const perSkin = { ...(prev?.skinDaily || {}) };
    const fresh = Date.now() - 24 * 3600e3;
    const queue = [...new Set(ids)].filter(id => !perSkin[id] || Date.parse(perSkin[id].at) < fresh)
      .sort((a, b) => (perSkin[a] ? Date.parse(perSkin[a].at) : 0) - (perSkin[b] ? Date.parse(perSkin[b].at) : 0)).slice(0, skinPagesLimit);
    let done = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const r = await openAndRun(ctx, `https://sbox.game/metrics/skins/${id}`, `document.body.innerText.includes('Lifetime Stats')`, SKIN_PAGE_SCRIPT);
          const byDate = {};
          r.sold.forEach(p => { (byDate[day(p[0])] = byDate[day(p[0])] || [0, 0, 0])[0] = p[1]; });
          r.refundedDaily.forEach(p => { (byDate[day(p[0])] = byDate[day(p[0])] || [0, 0, 0])[1] = p[1]; });
          r.net.forEach(p => { (byDate[day(p[0])] = byDate[day(p[0])] || [0, 0, 0])[2] = Math.round(p[1] * 100) / 100; });
          perSkin[id] = { at: nowIso(), name: r.name, storePrice: r.store_price, leftStore: r.left_store, category: r.category, package: r.package,
            unitsSold: r.units_sold, netRevenue: r.net_revenue, uniqueBuyers: r.unique_buyers, refunded: r.refunded, drops: r.drops,
            daily: Object.entries(byDate).sort().map(([d, v]) => [d, ...v]) };
          done++;
        } catch (e) { out.errors.push(`skin ${id}: ${e.message}`); }
      }
    });
    await Promise.all(workers);
    out.skinDaily = perSkin;
    out.skinPagesUpdated = done;
  } finally { await browser.close(); }
  if (!out.finance && !out.skinRevenue) throw new Error(out.errors.join('; '));
  return out;
}
