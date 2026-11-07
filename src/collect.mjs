// Точка входа сборщика. Запускается в GitHub Actions по расписанию.
// Каждый источник обновляется со своей частотой; при сбое остаётся прежний файл (с отметкой времени),
// поэтому игра всегда получает последние корректные данные.
//
//   node src/collect.mjs [--out=out] [--only=live,platform] [--force]
import fs from 'node:fs';
import { Store, nowIso } from './lib.mjs';
import * as src from './sources.mjs';
import { analytics } from './analytics.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const store = new Store(args.out || 'out');
const seeds = JSON.parse(fs.readFileSync(new URL('./seed-events.json', import.meta.url)));

// id, файл, минимальный интервал (минуты), функция
const SOURCES = [
  ['live', 'live.json', 0, (s, p) => src.live(s, p)],
  ['platform', 'platform.json', 30, (s, p) => src.platform(s, p)],
  ['packages', 'packages.json', 30, (s, p) => src.packages(s, p)],
  ['steam', 'steam.json', 60, (s, p) => src.steam(s, p)],
  ['events', 'events.json', 180, (s, p) => src.events(s, p, seeds)],
  ['skins', 'skins.json', 60, (s, p) => src.skins(s, p)],
  ['modes', 'modes/index.json', 60, (s, p) => src.modes(s, p, { limit: 60 })],
  ['skincards', 'skins/index.json', 180, (s, p) => src.skincards(s, p)],
  ['market', 'market.json', 60, (s, p) => src.market(s, p)],
  ['sboxgame', 'sboxgame.json', 180, async (s, p) => (await import('./sboxgame.mjs')).sboxgame(s, p, { skinPagesLimit: 100 })]
];

const manifest = store.read('manifest.json', { schema: 1, sources: {}, files: {} });
const only = args.only ? String(args.only).split(',') : null;
const t0 = Date.now();

for (const [id, file, minutes, fn] of SOURCES) {
  if (only && !only.includes(id)) continue;
  const st = (manifest.sources[id] = manifest.sources[id] || {});
  const last = st.lastSuccess ? Date.parse(st.lastSuccess) : 0;
  const due = args.force || !store.read(file) || Date.now() - last >= minutes * 60e3 - 60e3;
  if (!due) continue;
  const s0 = Date.now();
  st.lastAttempt = nowIso();
  try {
    const data = await fn(store, store.read(file));
    store.write(file, data);
    st.ok = true; st.lastSuccess = nowIso(); st.error = null; st.ms = Date.now() - s0;
    if (data && Array.isArray(data.errors) && data.errors.length) st.warnings = data.errors.slice(0, 10); else delete st.warnings;
    console.log(`✓ ${id} ${st.ms} мс`);
  } catch (e) {
    st.ok = false; st.error = String(e.message || e).slice(0, 300); st.ms = Date.now() - s0;
    console.log(`✗ ${id}: ${st.error}`);
  }
}

try {
  store.write('analytics.json', analytics(store));
  manifest.sources.analytics = { ok: true, lastSuccess: nowIso() };
} catch (e) { manifest.sources.analytics = { ok: false, error: e.message, lastAttempt: nowIso() }; console.log('✗ analytics: ' + e.message); }

// Манифест: игра скачивает его раз в минуту и догружает только изменившиеся файлы
const files = {};
const walk = (dir, rel = '') => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = rel ? `${rel}/${f.name}` : f.name;
    if (f.isDirectory()) walk(`${dir}/${f.name}`, p);
    else if (f.name.endsWith('.json') && p !== 'manifest.json') {
      const stt = fs.statSync(`${dir}/${f.name}`);
      files[p] = { bytes: stt.size, updatedAt: new Date(stt.mtimeMs).toISOString().replace(/\.\d+Z$/, 'Z') };
    }
  }
};
walk(store.dir);
manifest.files = files;
manifest.generatedAt = nowIso();
manifest.runMs = Date.now() - t0;
store.write('manifest.json', manifest);
fs.writeFileSync(store.file('.nojekyll'), '');
console.log(`готово за ${Math.round((Date.now() - t0) / 1000)} с`);
// Ошибка процесса только если не обновилось вообще ничего важного
if (!manifest.sources.live?.ok && !manifest.sources.platform?.ok) process.exitCode = 1;
