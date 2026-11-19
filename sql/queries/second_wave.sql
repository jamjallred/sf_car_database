-- name: ListSecondWaveForVins :many
SELECT vin, set_by, set_at FROM car_second_wave
WHERE vin = ANY(sqlc.arg('vins')::text[]);

-- name: SetSecondWave :execrows
-- Keeps the original time if the car is already ticked.
INSERT INTO car_second_wave (vin, set_by, set_at)
VALUES ($1, $2, $3)
ON CONFLICT (vin) DO NOTHING;

-- name: ClearSecondWave :execrows
DELETE FROM car_second_wave WHERE vin = $1;
