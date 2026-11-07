// Скрипты разбора страниц sbox.game (Blazor + ECharts). Перенесены из SboxAnalytics без изменений.

export const HELPERS = `
window.__sx = window.__sx || {
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  charts() {
    const out = [];
    if (!window.echarts) return out;
    document.querySelectorAll('div').forEach(d => {
      const inst = echarts.getInstanceByDom(d);
      if (!inst) return;
      const o = inst.getOption();
      let el = d, title = '';
      for (let k = 0; k < 8 && el; k++) {
        const t = el.querySelector && el.querySelector('.title');
        if (t) { title = t.innerText.trim(); break; }
        el = el.parentElement;
      }
      out.push({ title, series: (o.series || []).map(s => ({ name: s.name, type: s.type, data: s.data })) });
    });
    return out;
  },
  money(s) {
    if (s == null) return null;
    s = String(s).replace(/[\\s,]/g, '').replace('\\u2212', '-');
    const m = s.match(/(-?)\\$?(-?[\\d.]+)([kKmMbB]?)/);
    if (!m) return null;
    let v = parseFloat(m[2]);
    if (m[1] === '-' ) v = -Math.abs(v);
    const mul = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 }[m[3]] || 1;
    return v * mul;
  },
  num(s) {
    if (s == null) return null;
    const m = String(s).replace(/[\\s,]/g, '').match(/-?[\\d.]+[kKmM]?/);
    if (!m) return null;
    return this.money(m[0]);
  },
  // Элементы между заголовком секции и следующим заголовком
  inSec(titlePart) {
    const titles = [...document.querySelectorAll('.title')];
    const t = titles.find(e => e.innerText.includes(titlePart));
    if (!t) return null;
    const nxt = titles[titles.indexOf(t) + 1];
    return el => !!(t.compareDocumentPosition(el) & 4) && (!nxt || !!(el.compareDocumentPosition(nxt) & 4));
  },
  secAll(titlePart, sel) { const f = this.inSec(titlePart); return f ? [...document.querySelectorAll(sel)].filter(f) : []; },
  table(titlePart) { return this.secAll(titlePart, 'table').find(t => !t.parentElement.closest('td')) || null; },
  rows(table) {
    if (!table) return [];
    const body = table.querySelector(':scope > tbody') || table;
    return [...body.querySelectorAll(':scope > tr')].map(tr => {
      const cells = [...tr.querySelectorAll(':scope > td')];
      const a = tr.querySelector('a[href]');
      return { cells: cells.map(c => c.innerText.trim()), href: a ? a.getAttribute('href') : null };
    });
  },
  section(titlePart) { return this.inSec(titlePart) ? titlePart : null; },
  async clickIn(titlePart, text) {
    const b = this.secAll(titlePart, 'a.btn, button').find(e => e.innerText.trim() === text);
    if (!b) return false;
    b.click();
    return true;
  },
  async viewAll(titlePart) {
    const b = this.secAll(titlePart, 'a.btn, button').find(e => /^View all/.test(e.innerText.trim()));
    if (!b) return false;
    b.click();
    return true;
  },
  async clickText(root, text) {
    const b = [...(root || document).querySelectorAll('a.btn, button, a')].find(e => e.innerText.trim() === text);
    if (!b) return false;
    b.click();
    return true;
  },
  async clickViewAll(root) {
    const b = [...(root || document).querySelectorAll('a.btn, button, a')].find(e => /^View all/.test(e.innerText.trim()));
    if (!b) return false;
    b.click();
    return true;
  }
};
true;
`;

export const SKINS_OVERVIEW_SCRIPT = `
  const out = { revenue: [], latest: [], topEarning: [], top: {}, drops: {}, ids: [] };
  const rev = __sx.charts().find(c => c.title.includes('Daily Skin Revenue')) || __sx.charts()[0];
  if (rev) out.revenue = (rev.series.find(s => s.name === 'Total') || rev.series[0] || { data: [] }).data;
  const ids = new Set();
  const grab = () => document.querySelectorAll('a[href^="/metrics/skins/"]').forEach(a => ids.add(a.getAttribute('href').split('/').pop()));
  const tableOf = title => __sx.rows(__sx.table(title));
  out.latest = tableOf('Latest Added');
  out.topEarning = tableOf('Top Earning');
  grab();
  const periodRead = async (title, p) => {
    const before = (__sx.table(title) || {}).innerText || '';
    if (!(await __sx.clickIn(title, p))) return null;
    for (let k = 0; k < 15; k++) { await __sx.sleep(400); const tt = __sx.table(title); if (tt && tt.innerText !== before) break; }
    await __sx.sleep(500);
    if (await __sx.viewAll(title)) await __sx.sleep(2500);
    grab();
    return tableOf(title);
  };
  for (const p of ['24h', '7d', '30d', '90d', '1y', 'All']) { const r = await periodRead('Top Skins', p); if (r) out.top[p] = r; }
  for (const p of ['24h', '7d', '30d', '90d', '1y']) { const r = await periodRead('Skin Drops', p); if (r) out.drops[p] = r; }
  out.ids = [...ids];
  return out;
`;

export const SKIN_PAGE_SCRIPT = `
  const t = document.body.innerText;
  const name = document.title.split(' - Skins')[0].trim();
  const life = re => { const m = t.match(re); return m ? __sx.money(m[1]) : null; };
  const head = (t.split('Lifetime Stats')[0] || '');
  const lines = head.split('\\n').map(s => s.trim()).filter(Boolean);
  const iName = lines.lastIndexOf(name);
  const info = iName >= 0 ? lines.slice(iName + 1) : [];
  const statusLine = info.find(l => /store/i.test(l) && !/in store$/i.test(l)) || '';
  const priceLine = info.find(l => /in store$/i.test(l)) || '';
  const left = statusLine.match(/Left store\\s+(.+)/i);
  let pkg = null;
  const fromLine = info.find(l => /^From /.test(l));
  if (fromLine) {
    const title = fromLine.slice(5).trim();
    const a = [...document.querySelectorAll('a[href]')].find(a => a.innerText.trim() === title && /^\\/[^/]+\\/[^/]+$/.test(a.getAttribute('href')));
    pkg = a ? a.getAttribute('href').slice(1).replace('/', '.') : title;
  }
  const createdIdx = info.findIndex(l => /^Created /.test(l));
  const category = createdIdx > 0 ? info[createdIdx - 1] : null;
  const ch = __sx.charts();
  const series = {}; ch.forEach(c => c.series.forEach(s => { series[s.name] = s.data; }));
  const icon = (document.querySelector('img[src*="/inventory/icons/"]') || {}).src || null;
  return {
    name, description: info[0] && !/store|Marketable|Tradable/i.test(info[0]) ? info[0] : '',
    store_status: statusLine, left_store: left ? left[1] : null,
    store_price: priceLine ? __sx.money(priceLine) : null,
    marketable: info.includes('Marketable') ? 1 : 0, tradable: info.includes('Tradable') ? 1 : 0,
    category, package: pkg, icon,
    units_sold: life(/Units sold\\s+([\\d,.]+)/), net_revenue: life(/Net revenue\\s+(-?\\$?[\\d,.]+)/),
    unique_buyers: life(/Unique buyers\\s+([\\d,.]+)/), refunded: life(/Units refunded\\s+([\\d,.]+)/),
    drops: life(/Drops granted\\s+([\\d,.]+)/),
    sold: series['Sold'] || [], refundedDaily: series['Refunded'] || [], net: series['Net'] || []
  };
`;

export const FINANCE_SCRIPT = `
  const out = { monthly: [], daily: [] };
  out.monthly = __sx.rows(__sx.table('Monthly Finances')).map(r => r.cells);
  if (await __sx.clickIn('Money', '1Y')) await __sx.sleep(3500);
  const c = __sx.charts()[0];
  if (c) out.daily = c.series.map(x => ({ name: x.name, data: x.data }));
  return out;
`;

export const PLAYFUND_SCRIPT = `
  const t = document.body.innerText;
  const m = t.match(/\\$([\\d,.]+)\\s*\\n?\\s*paid to community/);
  const out = { total: m ? __sx.money(m[1]) : null, top: {} };
  for (const p of ['7d', '30d', '90d', '1y', 'All']) {
    if (await __sx.clickIn('Top Packages', p)) await __sx.sleep(3000);
    if (await __sx.viewAll('Top Packages')) await __sx.sleep(2500);
    out.top[p] = __sx.rows(__sx.table('Top Packages'));
  }
  return out;
`;
