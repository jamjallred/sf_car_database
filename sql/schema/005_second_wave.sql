-- +goose Up
-- Cars ticked "2nd Wave" on the inventory page: one row per ticked car, and
-- unticking deletes it. Ticks and unticks are logged in car_dibs_log with
-- claimant '2nd Wave' (action 'claim' = ticked, 'release' = unticked).
CREATE TABLE car_second_wave (
    vin TEXT PRIMARY KEY REFERENCES cars(vin) ON DELETE CASCADE,
    set_by TEXT NOT NULL DEFAULT '',
    set_at TIMESTAMP NOT NULL
);

-- +goose Down
DROP TABLE car_second_wave;
