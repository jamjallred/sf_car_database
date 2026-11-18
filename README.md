# sf_car_database

Internal Go web app for building inventory spreadsheets and browsing the car database.

## Pages

| URL | What it does |
| --- | --- |
| `/app/` | Dashboard |
| `/app/generate_grounded` | Grounded CSV → grounded sheet (adds auction names) |
| `/app/nationwide` | In-service `.xlsx` export → nationwide sheet, saved to the database in the same step (see [Nationwide imports](#nationwide-imports)) |
| `/app/generate_final_report` | Dibs sheet + results CSV → final report |
| `/app/inventory` | The latest nationwide sheet's cars (older ones by search), filter by pasted VINs, call dibs, notes |
| `/app/price_check` | Daily export (.csv or .xlsx) → compare each VIN's price with its aviscarsales.com listing |

## API

| Method | Path | Body / query |
| --- | --- | --- |
| `POST` | `/api/generate_grounded` | multipart `file` (.csv) |
| `POST` | `/api/create_sheet` | multipart `file` (.xlsx) or raw body → the nationwide sheet, also upserted into `cars`; `X-Sheet-Summary` header on the response, plus `X-Save-Error` if the database save failed |
| `POST` | `/api/generate_final_report` | multipart `dibs` (.xlsx) + `initial` (.csv) |
| `POST` | `/api/saveToDB` | multipart `file` (nationwide .xlsx) or raw body → `{inserted, updated, skipped}` (re-saves an existing sheet; the page no longer uses it) |
| `POST` | `/api/updateAirportCodes` | — → `{codes}` |
| `GET` | `/api/cars` | `q`, `state`, `vins` (split on commas, semicolons or whitespace), `scope` (`latest` default, or `all`), `limit` (number or `all`), `offset` → cars with their `dibs` (oldest first), `notes` and `inLatest`, plus the `latest` import |
| `POST` | `/api/notes` | JSON `{updatedBy, changes: [{vin, name, note}]}` (empty note deletes) → `{notes}` |
| `POST` | `/api/dibs` | JSON `{calledBy, changes: [{vin, name, claim}]}` → `{claimed, released, dibs}` |
| `GET` | `/api/dibs/all` | Cars on the latest nationwide sheet with an active dibs → `{cars, dibsNames, latest}` |
| `GET` | `/api/dibs/all.xlsx?tz=` | The same cars as a workbook (dibs as TRUE/FALSE; `tz`, e.g. `America/Chicago`, sets the filename's date) |
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

## Nationwide imports

Each nationwide sheet generated is saved to the database as one import (`nationwide_imports`), in a single transaction:

- Every car on the sheet is upserted into `cars` by VIN, so new VINs are added, VINs already there take the new sheet's details, and cars not on this sheet stay as they were. Each car's `last_import_id` records the latest import it appeared in.
- Cars from the in-service export whose airport code isn't in the airport code map (and so aren't on the sheet) go to `unmapped_cars`, keyed by VIN, with their full in-service row: `raw` in the export's column order and `fields` by header name. A VIN seen again is updated, keeping its `first_seen`. There's no page for this table yet.

The inventory page shows the cars of the most recent import by default. A search or pasted VINs looks through every car, and "Include older cars" shows them all; cars not on the latest sheet are shown in grey. Before the first import (an empty `nationwide_imports`), every car is shown.

Migration `004_imports.sql` treats the cars saved at the newest `timestamp` as the first import, so existing data keeps working.

## Dibs

The inventory page has a checkbox column for each name in `dibsNames` (`handlerDibs.go`): Mike, Stan, Jaxon and Gregg. Ticked and unticked boxes stay in the browser until someone presses **Call Dibs**, which saves all the changes in one transaction. Active dibs live in `car_dibs` with the time they were called, and unticking a box deletes its row. Every claim and release is also written to `car_dibs_log`, along with the profile name of whoever pressed the button.

To tick many boxes at once, drag down a dibs column, Shift+click a second box, or click the column's heading to select every box shown, then press Space. Space unticks them instead if they're all ticked already, and Esc clears the selection. These are still unsaved changes until Call Dibs. Only the box itself changes a tick: clicking the rest of the cell selects that one box.

For every kind of selection (dibs boxes, notes, car details), clicking anywhere other than a highlighted cell clears it. Clicking inside the selection keeps it, and dragging from there starts a new one. Shift+click extends it, and scrollbars and column resizing leave it alone. To edit a note inside a selected run, double-click it.

**All Dibs** (top right of the page) opens a pop-up listing every car on the latest nationwide sheet that has at least one saved dibs. It shows all columns, including any hidden in the Columns menu: the car details, each person's dibs (a read-only tick, coloured by order) and their notes. **Export .xlsx** downloads the same list as `all_dibs_YYYY-MM-DD.xlsx`, with each dibs cell TRUE or FALSE and the claimed ones coloured. Unsaved ticks aren't included, and exports aren't archived in `ABSOLUTE_DIRECTORY`.

A car's dibs are coloured in the order they were called: 1st green, 2nd blue, 3rd yellow, 4th orange. Re-saving a box that's already ticked keeps its original time, and releasing a dibs moves the later ones up a place.

Each person also has a notes column. The notes sit in a panel that the **Notes** tab on the table's right edge slides out over the dibs columns, row for row, and tucks away again. Notes save on their own shortly after you leave the cell, into `car_notes` (one row per car per person, with who last changed it and when). Dragging the small square in the selected cell's corner down copies its text into the cells below, like Excel's fill handle. To clear many notes at once, drag down a notes column, Shift+click a second note, or click the column's label to select them, then press Delete or Backspace. That saves straight away, and an Undo link appears for a minute.

To copy car details, click a cell, drag across cells, or Shift+click to select a block, then press Ctrl+C (⌘C on a Mac). It pastes into a spreadsheet as rows and columns, leaving out hidden columns. Ctrl+C also copies a selected run of notes.

The **Columns** button lists every column; untick one to hide it. Hidden columns, column widths and whether the notes panel is out are remembered in that browser.

Apply the migrations with `goose -dir sql/schema postgres "$DB_URL" up`.

## Avis price check

The price check reads aviscarsales.com's inventory feed (`POST /api/widget/ws-inv-data/getInventory`), the same one its search pages use. Instead of one search per VIN, the server downloads the whole used inventory 48 cars at a time (about 70 requests for ~3,300 cars) with `AVIS_REQUEST_DELAY` between requests, so a full download takes roughly 7 minutes at the default 6 seconds. The result is kept in memory for `AVIS_CACHE_TTL` (6 hours) and shared by everyone using the page; "Re-download Avis prices" forces a fresh copy.

Before each download the server re-reads robots.txt. It stops if the rules for `*` disallow the inventory page or the feed, and it uses the site's Crawl-delay if that is longer than ours. It retries a failed page twice with long back-offs, and gives up straight away on 401/403/404.

The AVIS Retail price is the listing's "TOTAL PRICE", which includes fees (the feed's `priceAfterFees`). A listing without a total uses its "Avis Price" plus "Total Fees". The sheet price comes from the first of these columns with a value: Sale Price, Buy It Now Price, Price, Asking Price, Internet Price, Opening Price.
