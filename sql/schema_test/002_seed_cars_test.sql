-- +goose Up
-- Create staging table
-- Insert into real table with conversions
INSERT INTO cars (
    state,
    city,
    year,
    make,
    model,
    trim,
    drive,
    vin,
    color,
    miles,
    price,
    msrp,
    notes1,
    notes2
)
SELECT
    state,
    city,
    year,
    make,
    model,
    trim,
    drive,
    vin,
    color,
    miles,
    REPLACE(REPLACE(price, '$', ''), ',', '')::integer,
    REPLACE(REPLACE(msrp,  '$', ''), ',', '')::integer,
    COALESCE(notes1, ''),
    COALESCE(notes2, '')
FROM cars_staging;

-- +goose Down
TRUNCATE TABLE cars RESTART IDENTITY CASCADE;
TRUNCATE TABLE cars_staging;