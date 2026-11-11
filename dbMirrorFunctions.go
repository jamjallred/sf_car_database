package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jamjallred/sf_car_database/internal/database"
)

// LookupAuction implements excelutils.AuctionLookup using city_auction_map.
func (cfg *apiConfig) LookupAuction(ctx context.Context, city, state string) (string, bool, error) {
	name, err := cfg.dbQueries.GetAuction(ctx, database.GetAuctionParams{
		StateCode: state,
		City:      city,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return name, true, nil
}
