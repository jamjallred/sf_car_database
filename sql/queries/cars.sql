-- name: CreateCar :one
INSERT INTO cars (
    state, city, year, make, model, trim, drive, vin, color, miles, price, msrp, timestamp
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
)
RETURNING *;

-- name: UpsertCar :one
-- Inserts a car or refreshes an existing VIN. Returns true when the row is new.
INSERT INTO cars (
    state, city, year, make, model, trim, drive, vin, color, miles, price, msrp, timestamp, last_import_id
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
)
ON CONFLICT (vin) DO UPDATE SET
    last_import_id = EXCLUDED.last_import_id,
    state = EXCLUDED.state,
    city = EXCLUDED.city,
    year = EXCLUDED.year,
    make = EXCLUDED.make,
    model = EXCLUDED.model,
    trim = EXCLUDED.trim,
    drive = EXCLUDED.drive,
    color = EXCLUDED.color,
    miles = EXCLUDED.miles,
    price = EXCLUDED.price,
    msrp = EXCLUDED.msrp,
    timestamp = EXCLUDED.timestamp
RETURNING (xmax = 0)::boolean AS inserted;

-- name: GetFirstXRows :many
SELECT * FROM cars
LIMIT $1;

-- name: SearchCars :many
SELECT * FROM cars
WHERE (sqlc.narg('search')::text IS NULL
       OR vin ILIKE '%' || sqlc.narg('search')::text || '%'
       OR make ILIKE '%' || sqlc.narg('search')::text || '%'
       OR model ILIKE '%' || sqlc.narg('search')::text || '%'
       OR city ILIKE '%' || sqlc.narg('search')::text || '%')
  AND (sqlc.narg('states')::text[] IS NULL OR state = ANY(sqlc.narg('states')::text[]))
  AND (sqlc.narg('places')::text[] IS NULL OR (state || '|' || city) = ANY(sqlc.narg('places')::text[]))
  AND (sqlc.narg('vins')::text[] IS NULL OR vin = ANY(sqlc.narg('vins')::text[]))
  AND (sqlc.narg('import_id')::bigint IS NULL OR last_import_id = sqlc.narg('import_id')::bigint)
  AND (NOT sqlc.arg('marked')::boolean
       OR EXISTS (SELECT 1 FROM car_dibs d WHERE d.vin = cars.vin)
       OR EXISTS (SELECT 1 FROM car_second_wave w WHERE w.vin = cars.vin)
       OR EXISTS (SELECT 1 FROM car_notes n WHERE n.vin = cars.vin AND btrim(n.note) <> ''))
ORDER BY state, city, year, make, model
LIMIT sqlc.arg('lim') OFFSET sqlc.arg('off');

-- name: CountCars :one
SELECT count(*) FROM cars
WHERE (sqlc.narg('search')::text IS NULL
       OR vin ILIKE '%' || sqlc.narg('search')::text || '%'
       OR make ILIKE '%' || sqlc.narg('search')::text || '%'
       OR model ILIKE '%' || sqlc.narg('search')::text || '%'
       OR city ILIKE '%' || sqlc.narg('search')::text || '%')
  AND (sqlc.narg('states')::text[] IS NULL OR state = ANY(sqlc.narg('states')::text[]))
  AND (sqlc.narg('places')::text[] IS NULL OR (state || '|' || city) = ANY(sqlc.narg('places')::text[]))
  AND (sqlc.narg('vins')::text[] IS NULL OR vin = ANY(sqlc.narg('vins')::text[]))
  AND (sqlc.narg('import_id')::bigint IS NULL OR last_import_id = sqlc.narg('import_id')::bigint)
  AND (NOT sqlc.arg('marked')::boolean
       OR EXISTS (SELECT 1 FROM car_dibs d WHERE d.vin = cars.vin)
       OR EXISTS (SELECT 1 FROM car_second_wave w WHERE w.vin = cars.vin)
       OR EXISTS (SELECT 1 FROM car_notes n WHERE n.vin = cars.vin AND btrim(n.note) <> ''));

-- name: ListStates :many
SELECT DISTINCT state FROM cars ORDER BY state;

-- name: ListCities :many
SELECT DISTINCT state, city FROM cars WHERE city <> '' ORDER BY city, state;
