-- +goose Up
-- Free-text notes, one per car per person (the "Mike Notes" etc. columns on
-- the inventory page). Clearing a note deletes its row.
CREATE TABLE car_notes (
    vin TEXT NOT NULL REFERENCES cars(vin) ON DELETE CASCADE,
    claimant TEXT NOT NULL,
    note TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (vin, claimant)
);

-- +goose Down
DROP TABLE car_notes;
