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
    timestamp TIMESTAMP NOT NULL
);

CREATE TABLE cars_staging (
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
    price TEXT NOT NULL,
    msrp TEXT NOT NULL,
    notes1 TEXT,
    notes2 TEXT,
    timestamp TIMESTAMP
);

CREATE TABLE customers (
    customer_id TEXT PRIMARY KEY
);

CREATE TABLE cars_customers (
    id SERIAL PRIMARY KEY,
    vin TEXT references cars(vin),
    customer_id INTEGER REFERENCES customers(customer_id),
    username TEXT NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    UNIQUE (vin, customer_id)
);

CREATE TABLE city_auction_map (
    state_code TEXT,
    city TEXT,
    auction_name TEXT NOT NULL,
    PRIMARY KEY (city, state_code)
);

-- +goose Down
DROP TABLE cars;
DROP TABLE cars_staging;
DROP TABLE customers;
DROP TABLE cars_customers;
DROP TABLE city_auction_map;