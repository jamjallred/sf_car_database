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
