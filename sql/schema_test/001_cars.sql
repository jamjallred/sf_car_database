-- +goose Up
CREATE TABLE cars (
    state TEXT NOT NULL,
    city TEXT NOT NULL,
    year TEXT NOT NULL,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    trim TEXT NOT NULL,
    drive TEXT NOT NULL,
    vin TEXT PRIMARY KEY,
    color TEXT NOT NULL,
    miles INTEGER NOT NULL,
    price INTEGER NOT NULL,
    msrp INTEGER NOT NULL,
    notes1 TEXT,
    notes2 TEXT
);

CREATE TABLE cars_staging (
    state TEXT NOT NULL,
    city TEXT NOT NULL,
    year TEXT NOT NULL,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    trim TEXT NOT NULL,
    drive TEXT NOT NULL,
    vin TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    miles INTEGER NOT NULL,
    price TEXT NOT NULL,
    msrp TEXT NOT NULL,
    notes1 TEXT,
    notes2 TEXT
);

-- +goose Down
DROP TABLE cars;
DROP TABLE cars_staging;