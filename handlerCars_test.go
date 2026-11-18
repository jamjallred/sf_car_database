package main

import (
	"slices"
	"testing"
)

func TestSplitVINs(t *testing.T) {
	got := splitVINs("1abc, 2DEF\n3ghi\t\"4JKL\";  2def\r\n\n")
	want := []string{"1ABC", "2DEF", "3GHI", "4JKL"}
	if !slices.Equal(got, want) {
		t.Fatalf("splitVINs = %v, want %v", got, want)
	}
	if got := splitVINs("  \n, "); got != nil {
		t.Fatalf("splitVINs(blank) = %v, want nil", got)
	}
}
