-- name: CreateImport :one
INSERT INTO nationwide_imports (created_at) VALUES ($1) RETURNING id;

-- name: FinishImport :exec
UPDATE nationwide_imports SET cars = $2, unmapped = $3 WHERE id = $1;

-- name: LatestImport :one
SELECT id, created_at, cars FROM nationwide_imports ORDER BY id DESC LIMIT 1;

-- name: UpsertUnmappedCar :exec
-- A VIN seen again takes the newest row; first_seen is kept.
INSERT INTO unmapped_cars (vin, airport_code, fields, raw, import_id, first_seen, last_seen)
VALUES ($1, $2, $3, $4, $5, $6, $6)
ON CONFLICT (vin) DO UPDATE SET
    airport_code = EXCLUDED.airport_code,
    fields = EXCLUDED.fields,
    raw = EXCLUDED.raw,
    import_id = EXCLUDED.import_id,
    last_seen = EXCLUDED.last_seen;
