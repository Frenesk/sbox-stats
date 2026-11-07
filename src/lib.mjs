// Общие утилиты сборщика: HTTP с повторами, чтение/запись JSON, состояние источников.
import fs from 'node:fs';
import path from 'node:path';

export const UA = 'sbox-stats-collector/1.0 (+https://github.com; public s&box metrics for an in-game dashboard)';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const day = ms => new Date(ms).toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export async function http(url, { json = true, timeout = 30000, retries = 3, headers = {} } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*', ...headers } });
      clearTimeout(t);
      if (r.status === 429) throw Object.assign(new Error(`429 ${url}`), { status: 429 });
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status} ${url}`);
        e.status = r.status;
        if (r.status >= 400 && r.status < 500) e.fatal = true;
        throw e;
      }
      const text = await r.text();
      if (!json) return text;
      try { return JSON.parse(text); } catch { throw Object.assign(new Error(`не JSON (${text.slice(0, 80)}) ${url}`), { fatal: true }); }
    } catch (e) {
      clearTimeout(t);
      last = e.name === 'AbortError' ? new Error(`таймаут ${url}`) : e;
      if (e.fatal) throw last;
      if (i < retries - 1) await sleep((e.status === 429 ? 15000 : 1500) * 2 ** i);
    }
  }
  throw last;
}

// Простой пул параллельных задач
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } }
  }));
  return out;
}

export class Store {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  file(name) { return path.join(this.dir, name); }
  read(name, def = null) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return def; } }
  write(name, data) {
    const f = this.file(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(data));
    fs.renameSync(f + '.tmp', f);
  }
}

// Число из строки вида "$297.5k", "-$46.7k", "1,234"
export function money(s) {
  if (s == null) return null;
  const m = String(s).replace(/[\s,]/g, '').replace('−', '-').match(/(-?)\$?(-?[\d.]+)([kKmMbB]?)/);
  if (!m) return null;
  let v = parseFloat(m[2]);
  if (m[1] === '-') v = -Math.abs(v);
  return v * ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 }[m[3]] || 1);
}

// Таблица в компактном виде: { cols: [...], rows: [[...], ...] } — в 3-5 раз меньше массива объектов
export const table = (cols, rows) => ({ cols, rows });
