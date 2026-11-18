-- name: ListNotesForVins :many
SELECT vin, claimant, note FROM car_notes
WHERE vin = ANY(sqlc.arg('vins')::text[]);

-- name: UpsertNote :exec
INSERT INTO car_notes (vin, claimant, note, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (vin, claimant) DO UPDATE SET
    note = EXCLUDED.note,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at
WHERE car_notes.note IS DISTINCT FROM EXCLUDED.note;

-- name: DeleteNote :exec
DELETE FROM car_notes WHERE vin = $1 AND claimant = $2;
