-- +goose Up
CREATE TABLE dibs (
    vin TEXT PRIMARY KEY,
    queue JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- +goose Down
DROP TABLE dibs;