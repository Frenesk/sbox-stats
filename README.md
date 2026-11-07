# sbox-stats

Публичные метрики платформы **s&box**, собранные в компактные JSON-файлы для игрового дашборда
(и любых других клиентов). Обновляются GitHub Actions каждые ~10 минут.

## Где брать данные

Файлы лежат в ветке `data` и доступны по трём адресам (клиент пробует их по очереди):

| Зеркало | Адрес |
|---|---|
| GitHub Pages | `https://<owner>.github.io/<repo>/<файл>` |
| jsDelivr (CDN, в т.ч. Азия) | `https://cdn.jsdelivr.net/gh/<owner>/<repo>@data/<файл>` |
| raw.githubusercontent.com | `https://raw.githubusercontent.com/<owner>/<repo>/data/<файл>` |

Начинать с `manifest.json`: в нём список файлов с временем обновления и состояние каждого источника.

| Файл | Содержимое | Частота |
|---|---|---|
| `live.json` | онлайн платформы сейчас, Steam сейчас, топ режимов по онлайну, топ sbox.watch (пик 24 ч, momentum, недельное время), онлайн за 24 ч и 7 дней | 10 мин |
| `analytics.json` | готовые KPI, влияние событий, корреляции, концентрация, выводы (ru/en) | 10 мин |
| `platform.json` | история платформы по дням с 06.04.2021 и по часам за 31 день, удержание когорт | 30 мин |
| `packages.json` | каталог всех игровых режимов | 30 мин |
| `modes/index.json`, `modes/<ident>.json` | аналитика топ-60 режимов: история онлайна (24ч/7д/30д/1г/всё), 135 дней игроков, почасовой профиль | 60 мин |
| `skins.json` | полный каталог скинов (sbox.dev) + накопленная история цен | 60 мин |
| `steam.json` | онлайн Steam (SteamCharts), отзывы | 60 мин |
| `events.json` | события: релизы, цены, бета, джемы, новости | 3 ч |
| `market.json` | торговая площадка Steam + история цен | 3 ч |
| `sboxgame.json` | финансы Facepunch, Play Fund, выручка скинов по дням, продажи каждого скина | 3 ч |

Таблицы хранятся компактно: `{ "cols": [...], "rows": [[...], ...] }`. Время — UTC (ISO-8601 или Unix мс). `null` — «нет данных», а не 0.

## Источники
- [public.facepunch.com/sbox](https://public.facepunch.com/sbox) — официальный API s&box
- [sbox.watch](https://sbox.watch/api-docs/) — публичный API
- [sbox.dev](https://sbox.dev) — каталог скинов
- [sbox.game/metrics](https://sbox.game/metrics) — финансы, Play Fund, скины (через Playwright)
- Steam Web API, магазин и торговая площадка Steam, [SteamCharts](https://steamcharts.com/app/590830)

## Запуск локально
```
npm ci
npx playwright install chromium
node src/collect.mjs --out=out            # по расписанию источников
node src/collect.mjs --out=out --force    # всё сразу
node src/collect.mjs --out=out --only=live,platform
```

## Надёжность
- Если источник не ответил, остаётся прежний файл, а в `manifest.json` записывается ошибка и время последнего успеха.
- История платформы не может «укоротиться»: при подозрительном ответе сохраняется прежняя.
- Ветка `data` перезаписывается одним коммитом, поэтому репозиторий не растёт.
