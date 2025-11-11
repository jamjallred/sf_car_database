-- +goose Up
CREATE TABLE cars (
    state TEXT NOT NULL,
    city TEXT NOT NULL,
    year TEXT NOT NULL,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    drive TEXT NOT NULL,
    vin TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    miles INTEGER NOT NULL,
    price INTEGER NOT NULL,
    msrp INTEGER NOT NULL
);

-- +goose Down
DROP TABLE cars;