package main

import (
	"context"

	"github.com/jamjallred/sf_car_database/internal/database"
	excelutils "github.com/jamjallred/sf_server_utils"
)

func (cfg *apiConfig) GetAuction(ctx context.Context, city, state string) (excelutils.AuctionInfo, error) {
	// call SQLC
	row, err := cfg.dbQueries.GetAuction(ctx, database.GetAuctionParams{
		City:      city,
		StateCode: state,
	})
	if err != nil {
		return excelutils.AuctionInfo{}, err
	}

	// map result to mirror struct in external package
	return excelutils.AuctionInfo{
		AuctionName: row,
	}, nil
}

func (cfg *apiConfig) CheckAuctionExists(ctx context.Context, city, state string) (bool, error) {
	// no struct to map to if single value return
	return cfg.dbQueries.CheckAuctionExists(ctx, database.CheckAuctionExistsParams{
		City:      city,
		StateCode: state,
	})
}
