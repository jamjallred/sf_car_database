-- +goose Up
-- One row per nationwide sheet saved to the database.
CREATE TABLE nationwide_imports (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL,
    cars INTEGER NOT NULL DEFAULT 0,      -- cars on the sheet
    unmapped INTEGER NOT NULL DEFAULT 0   -- cars left off for unknown airport codes
);

-- The latest import each car appeared in. The inventory page shows the cars
-- of the most recent import by default.
ALTER TABLE cars ADD COLUMN last_import_id BIGINT REFERENCES nationwide_imports(id);
CREATE INDEX cars_last_import_id_idx ON cars (last_import_id);

-- Existing data: treat the cars saved at the latest timestamp (one save
-- stamps every car with the same time) as the most recent import.
INSERT INTO nationwide_imports (created_at, cars)
SELECT max(timestamp), count(*) FILTER (WHERE timestamp = (SELECT max(timestamp) FROM cars))
FROM cars
HAVING count(*) > 0;

UPDATE cars SET last_import_id = (SELECT max(id) FROM nationwide_imports)
WHERE timestamp = (SELECT max(timestamp) FROM cars);

-- Cars from the in-service export whose airport code isn't in the airport
-- code map, so they're not on the nationwide sheet. Kept with their full
-- in-service row: `raw` in the export's column order, `fields` by header.
CREATE TABLE unmapped_cars (
    vin TEXT PRIMARY KEY,
    airport_code TEXT NOT NULL,
    fields JSONB NOT NULL,
    raw TEXT[] NOT NULL,
    import_id BIGINT NOT NULL REFERENCES nationwide_imports(id),
    first_seen TIMESTAMP NOT NULL,
    last_seen TIMESTAMP NOT NULL
);

-- +goose Down
DROP TABLE unmapped_cars;
ALTER TABLE cars DROP COLUMN last_import_id;
DROP TABLE nationwide_imports;
