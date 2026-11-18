-- name: ListDibsForVins :many
SELECT vin, claimant, claimed_at FROM car_dibs
WHERE vin = ANY(sqlc.arg('vins')::text[])
ORDER BY vin, claimed_at, id;

-- name: ClaimDibs :execrows
-- Keeps the original timestamp if this person already has dibs on the car.
INSERT INTO car_dibs (vin, claimant, called_by, claimed_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (vin, claimant) DO NOTHING;

-- name: ReleaseDibs :execrows
DELETE FROM car_dibs WHERE vin = $1 AND claimant = $2;

-- name: LogDibs :exec
INSERT INTO car_dibs_log (vin, claimant, action, called_by, at)
VALUES ($1, $2, $3, $4, $5);

-- name: ExistingVins :many
SELECT vin FROM cars WHERE vin = ANY(sqlc.arg('vins')::text[]);

-- name: ListDibbedCars :many
-- Cars with at least one active dibs, limited to one nationwide import when
-- import_id is given.
SELECT c.* FROM cars c
WHERE (sqlc.narg('import_id')::bigint IS NULL OR c.last_import_id = sqlc.narg('import_id')::bigint)
  AND EXISTS (SELECT 1 FROM car_dibs d WHERE d.vin = c.vin)
ORDER BY c.state, c.city, c.year, c.make, c.model, c.vin;
