package main

import "net/http"

func handlerDisplayTable(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
