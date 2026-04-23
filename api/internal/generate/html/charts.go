package html

import (
	"bytes"
	"encoding/base64"
	"fmt"
	htmltemplate "html/template"
	"image/color"
	"strings"

	"github.com/wcharczuk/go-chart/v2"
	"github.com/wcharczuk/go-chart/v2/drawing"
)

// chartFunc renders a PNG chart for the given data and returns it as an
// inline <img> tag.
//
// Usage (Go-template):
//
//	{{ chart .sales "line" }}
//	{{ chart .sales "bar" 480 280 }}
//	{{ chart .breakdown "pie" 360 }}
//	{{ chart .breakdown "doughnut" 360 }}
//
// Data shapes:
//
//   - line / bar : []map{ "label": "Jan", "value": 120 }
//                  (or "x" / "y" — both supported)
//   - pie / donut: []map{ "label": "Cash", "value": 40, "color": "#10b981" }
func chartFunc(args ...interface{}) htmltemplate.HTML {
	if len(args) == 0 {
		return errorImg("chart: missing data")
	}
	data := args[0]
	kind := "line"
	if len(args) > 1 {
		if s, ok := args[1].(string); ok && s != "" {
			kind = strings.ToLower(s)
		}
	}
	width, height := 480, 280
	if len(args) > 2 {
		if n, ok := toInt(args[2]); ok && n > 0 {
			width = n
		}
	}
	if len(args) > 3 {
		if n, ok := toInt(args[3]); ok && n > 0 {
			height = n
		}
	}

	rows, ok := asChartRows(data)
	if !ok || len(rows) == 0 {
		return errorImg("chart: expected an array of { label, value } objects")
	}

	var buf bytes.Buffer
	var err error
	switch kind {
	case "pie":
		err = renderPie(&buf, rows, width, height, false)
	case "doughnut", "donut":
		err = renderPie(&buf, rows, width, height, true)
	case "bar":
		err = renderBar(&buf, rows, width, height)
	default: // line
		err = renderLine(&buf, rows, width, height)
	}
	if err != nil {
		return errorImg("chart: " + err.Error())
	}
	uri := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	return htmltemplate.HTML(fmt.Sprintf(
		`<img src="%s" alt="%s chart" width="%d" height="%d" />`,
		uri, htmltemplate.HTMLEscapeString(kind), width, height,
	))
}

type chartRow struct {
	Label string
	Value float64
	Color string
}

// asChartRows coerces `[]interface{}` of maps into chartRow records.
func asChartRows(v interface{}) ([]chartRow, bool) {
	slice, ok := v.([]interface{})
	if !ok {
		return nil, false
	}
	out := make([]chartRow, 0, len(slice))
	for _, it := range slice {
		m, ok := it.(map[string]interface{})
		if !ok {
			return nil, false
		}
		label := firstString(m, "label", "x", "name")
		rawVal := firstValue(m, "value", "y", "amount")
		f, _ := asFloat(rawVal)
		colorStr := firstString(m, "color", "fill")
		out = append(out, chartRow{Label: label, Value: f, Color: colorStr})
	}
	return out, true
}

func firstString(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func firstValue(m map[string]interface{}, keys ...string) interface{} {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

// -- renderers -------------------------------------------------------------

var palette = []drawing.Color{
	drawing.ColorFromHex("10b981"), // emerald-500
	drawing.ColorFromHex("6366f1"), // indigo-500
	drawing.ColorFromHex("f59e0b"), // amber-500
	drawing.ColorFromHex("ef4444"), // red-500
	drawing.ColorFromHex("8b5cf6"), // violet-500
	drawing.ColorFromHex("06b6d4"), // cyan-500
	drawing.ColorFromHex("ec4899"), // pink-500
	drawing.ColorFromHex("84cc16"), // lime-500
}

func paletteColor(i int, override string) drawing.Color {
	if override != "" {
		c := drawing.ColorFromHex(strings.TrimPrefix(override, "#"))
		if c.A == 0 {
			c.A = 255
		}
		return c
	}
	return palette[i%len(palette)]
}

func renderLine(buf *bytes.Buffer, rows []chartRow, w, h int) error {
	xs := make([]float64, len(rows))
	ys := make([]float64, len(rows))
	labels := make([]chart.Tick, len(rows))
	for i, r := range rows {
		xs[i] = float64(i)
		ys[i] = r.Value
		labels[i] = chart.Tick{Value: float64(i), Label: r.Label}
	}
	graph := chart.Chart{
		Width:  w,
		Height: h,
		Background: chart.Style{
			FillColor: drawing.ColorTransparent,
			Padding:   chart.Box{Top: 10, Bottom: 10, Left: 10, Right: 10},
		},
		XAxis: chart.XAxis{
			Style:          chart.Style{FontSize: 9, FontColor: drawing.ColorFromHex("666666")},
			Ticks:          labels,
			GridMajorStyle: chart.Style{StrokeColor: drawing.ColorFromHex("eeeeee"), StrokeWidth: 1},
		},
		YAxis: chart.YAxis{
			Style:          chart.Style{FontSize: 9, FontColor: drawing.ColorFromHex("666666")},
			GridMajorStyle: chart.Style{StrokeColor: drawing.ColorFromHex("eeeeee"), StrokeWidth: 1},
		},
		Series: []chart.Series{
			chart.ContinuousSeries{
				Style: chart.Style{
					StrokeColor: palette[0],
					StrokeWidth: 2,
					FillColor:   palette[0].WithAlpha(48),
				},
				XValues: xs,
				YValues: ys,
			},
		},
	}
	return graph.Render(chart.PNG, buf)
}

func renderBar(buf *bytes.Buffer, rows []chartRow, w, h int) error {
	values := make([]chart.Value, len(rows))
	for i, r := range rows {
		values[i] = chart.Value{
			Value: r.Value,
			Label: r.Label,
			Style: chart.Style{FillColor: paletteColor(i, r.Color)},
		}
	}
	graph := chart.BarChart{
		Width:    w,
		Height:   h,
		BarWidth: max(20, (w-120)/max(1, len(rows))),
		Background: chart.Style{
			FillColor: drawing.ColorTransparent,
			Padding:   chart.Box{Top: 10, Bottom: 10, Left: 10, Right: 10},
		},
		XAxis: chart.Style{FontSize: 9, FontColor: drawing.ColorFromHex("666666")},
		YAxis: chart.YAxis{Style: chart.Style{FontSize: 9, FontColor: drawing.ColorFromHex("666666")}},
		Bars:  values,
	}
	return graph.Render(chart.PNG, buf)
}

func renderPie(buf *bytes.Buffer, rows []chartRow, w, h int, donut bool) error {
	values := make([]chart.Value, len(rows))
	for i, r := range rows {
		values[i] = chart.Value{
			Value: r.Value,
			Label: fmt.Sprintf("%s (%.0f)", r.Label, r.Value),
			Style: chart.Style{
				FillColor:   paletteColor(i, r.Color),
				StrokeColor: drawing.ColorWhite,
				StrokeWidth: 2,
				FontSize:    10,
				FontColor:   drawing.ColorFromHex("ffffff"),
			},
		}
	}
	if donut {
		graph := chart.DonutChart{
			Width:  w,
			Height: h,
			Background: chart.Style{
				FillColor: drawing.ColorTransparent,
			},
			Values: values,
		}
		return graph.Render(chart.PNG, buf)
	}
	graph := chart.PieChart{
		Width:  w,
		Height: h,
		Background: chart.Style{
			FillColor: drawing.ColorTransparent,
		},
		Values: values,
	}
	return graph.Render(chart.PNG, buf)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Silence unused-import noise if the platform doesn't need color package
// directly elsewhere — keeps this file import-stable.
var _ color.Color = color.Black
