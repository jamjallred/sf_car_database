# sf_car_database

Internal Go web app for building inventory spreadsheets and browsing the car database.

## Pages

| URL | What it does |
| --- | --- |
| `/app/` | Dashboard |
| `/app/generate_grounded` | Grounded CSV → grounded sheet (adds auction names) |
| `/app/nationwide` | In-service `.xlsx` export → nationwide sheet, then optionally save it to the database |
| `/app/generate_final_report` | Dibs sheet + results CSV → final report |
| `/app/inventory` | Search the `cars` table |
| `/app/price_check` | Daily export (.csv or .xlsx) → compare each VIN's price with its aviscarsales.com listing |

## API

| Method | Path | Body / query |
| --- | --- | --- |
| `POST` | `/api/generate_grounded` | multipart `file` (.csv) |
| `POST` | `/api/create_sheet` | multipart `file` (.xlsx) or raw body; `X-Sheet-Summary` header on the response |
| `POST` | `/api/generate_final_report` | multipart `dibs` (.xlsx) + `initial` (.csv) |
| `POST` | `/api/saveToDB` | multipart `file` (nationwide .xlsx) or raw body → `{inserted, updated, skipped}` |
| `POST` | `/api/updateAirportCodes` | — → `{codes}` |
| `GET` | `/api/cars` | `q`, `state`, `vins`, `limit`, `offset` |
| `GET` | `/api/cars/states` | — |
| `GET` | `/api/team` | — |
| `POST` | `/api/price_check/upload` | multipart `file` (.csv or .xlsx) → `{rows, priceColumn, duplicates}` |
| `GET` | `/api/avis/status` | — → download progress and snapshot age |
| `POST` | `/api/avis/refresh` | `?force=1` to re-download even if fresh |
| `POST` | `/api/avis/lookup` | JSON `{vins: [...]}` → `{fetchedAt, found}` |
| `GET` | `/healthz` | — |

Errors come back as `{"error": "message"}`, and the UI shows that message to the user.

## Running

```sh
cp .env.example .env   # then fill it in
go run .
```

`go.mod` replaces `sf_server_utils` with `../sf_server_utils`, so check out both repos side by side.

After editing anything in `sql/queries`, regenerate the database code with `sqlc generate`.

The front end is plain HTML/CSS/JS in `app/`, with no build step. Shared code lives in `app/css/app.css` and `app/js/common.js`.

## Avis price check

The price check reads aviscarsales.com's inventory feed (`POST /api/widget/ws-inv-data/getInventory`), the same one its search pages use. Instead of one search per VIN, the server downloads the whole used inventory 48 cars at a time (about 70 requests for ~3,300 cars) with `AVIS_REQUEST_DELAY` between requests, so a full download takes roughly 7 minutes at the default 6 seconds. The result is kept in memory for `AVIS_CACHE_TTL` (6 hours) and shared by everyone using the page; "Re-download Avis prices" forces a fresh copy.

Before each download the server re-reads robots.txt. It stops if the rules for `*` disallow the inventory page or the feed, and it uses the site's Crawl-delay if that is longer than ours. It retries a failed page twice with long back-offs, and gives up straight away on 401/403/404.

The Avis price compared is the "Avis Price" shown on the listing (the feed's `askingPrice`), before fees. The sheet price comes from the first of these columns with a value: Sale Price, Buy It Now Price, Price, Asking Price, Internet Price, Opening Price.
