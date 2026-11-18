-- +goose Up
-- One row per active dibs. Unchecking a box deletes the row; the order of a
-- car's dibs (1st = green, 2nd = blue, …) is claimed_at, then id.
CREATE TABLE car_dibs (
    id BIGSERIAL PRIMARY KEY,
    vin TEXT NOT NULL REFERENCES cars(vin) ON DELETE CASCADE,
    claimant TEXT NOT NULL,
    called_by TEXT NOT NULL DEFAULT '',
    claimed_at TIMESTAMP NOT NULL,
    UNIQUE (vin, claimant)
);

-- Every claim and release, kept after a dibs is released.
CREATE TABLE car_dibs_log (
    id BIGSERIAL PRIMARY KEY,
    vin TEXT NOT NULL,
    claimant TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('claim', 'release')),
    called_by TEXT NOT NULL DEFAULT '',
    at TIMESTAMP NOT NULL
);

-- +goose Down
DROP TABLE car_dibs_log;
DROP TABLE car_dibs;
