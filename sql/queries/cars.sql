-- name: CreateCar :one
INSERT INTO cars (
    state, city, year, make, model, drive, vin, color, miles, price, msrp
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
)
RETURNING *;