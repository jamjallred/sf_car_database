-- name: GetAuction :one
SELECT auction_name 
FROM city_auction_map 
WHERE state_code = $1 AND city = $2;

-- name: CheckAuctionExists :one
SELECT EXISTS(SELECT 1 FROM city_auction_map WHERE state_code = $1 AND city = $2);