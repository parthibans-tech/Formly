package html

import (
	"fmt"
	"math"
	"strings"
	"unicode"
)

// roundFunc rounds a numeric value to N decimal places.
//
//	{{ round .value 2 }}
func roundFunc(v interface{}, decimals int) float64 {
	f, _ := asFloat(v)
	if decimals < 0 {
		decimals = 0
	}
	pow := math.Pow10(decimals)
	return math.Round(f*pow) / pow
}

func ceilFunc(v interface{}) float64 {
	f, _ := asFloat(v)
	return math.Ceil(f)
}

func floorFunc(v interface{}) float64 {
	f, _ := asFloat(v)
	return math.Floor(f)
}

func absFunc(v interface{}) float64 {
	f, _ := asFloat(v)
	return math.Abs(f)
}

// ordinalFunc renders a small integer as English ordinal (1→1st, 2→2nd, …).
//
//	{{ ordinal 3 }}  →  3rd
func ordinalFunc(v interface{}) string {
	f, _ := asFloat(v)
	n := int(f)
	suffix := "th"
	switch n % 100 {
	case 11, 12, 13:
		suffix = "th"
	default:
		switch n % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return fmt.Sprintf("%d%s", n, suffix)
}

// pluralizeFunc picks the singular or plural form based on count.
//
//	{{ pluralize 1 "item" "items" }}  →  1 item
//	{{ pluralize 3 "item" "items" }}  →  3 items
//	{{ pluralize 2 "box" }}           →  2 boxs (simple +s fallback)
func pluralizeFunc(count interface{}, singular string, plural ...string) string {
	f, _ := asFloat(count)
	n := int(f)
	if n == 1 {
		return fmt.Sprintf("%d %s", n, singular)
	}
	pl := singular + "s"
	if len(plural) > 0 && plural[0] != "" {
		pl = plural[0]
	}
	return fmt.Sprintf("%d %s", n, pl)
}

// truncateFunc trims a string to N characters, appending "…" if shortened.
func truncateFunc(s string, n int) string {
	if n <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// capitalizeFunc upper-cases only the first letter.
func capitalizeFunc(s string) string {
	if s == "" {
		return s
	}
	runes := []rune(s)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

// titleCaseFunc lower-cases the input, then upper-cases each word's first letter.
func titleCaseFunc(s string) string {
	parts := strings.Fields(strings.ToLower(s))
	for i, p := range parts {
		runes := []rune(p)
		if len(runes) > 0 {
			runes[0] = unicode.ToUpper(runes[0])
			parts[i] = string(runes)
		}
	}
	return strings.Join(parts, " ")
}

// slugFunc creates a URL-safe slug: lowercase alphanumerics + single hyphens.
func slugFunc(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		case r == ' ' || r == '-' || r == '_':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.TrimRight(b.String(), "-")
}
