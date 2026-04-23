// Package generate wires the three generation modes behind a single Run() entrypoint.
// Both the sync HTTP handler and the async worker delegate here so there's one code path.
package generate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/generate/acroform"
	ghtml "github.com/docforge/api/internal/generate/html"
	gstatic "github.com/docforge/api/internal/generate/static"
	"github.com/docforge/api/internal/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Runner struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
}

type Result struct {
	OutputFileID string
	OutputKey    string
	OutputName   string
	Bytes        int
}

// Run loads a template and renders it with the supplied data. The output is
// persisted as a new File row and uploaded to MinIO. Returns a Result.
//
// Callers are responsible for tracking job status/audit if they're async.
func (r *Runner) Run(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, flatten bool) (*Result, error) {
	var (
		mode, storageKey, tplName string
		cfgRaw                    []byte
	)
	err := r.DB.QueryRow(ctx,
		`SELECT t.mode, t.name, t.config_json, f.storage_key
		 FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, templateID, orgID,
	).Scan(&mode, &tplName, &cfgRaw, &storageKey)
	if err != nil {
		return nil, fmt.Errorf("load template: %w", err)
	}

	pdfBytes, err := r.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return nil, fmt.Errorf("load source pdf: %w", err)
	}

	var output []byte
	switch mode {
	case "acroform":
		var cfg struct {
			Mappings map[string]acroform.Mapping `json:"mappings"`
		}
		_ = json.Unmarshal(cfgRaw, &cfg)
		if cfg.Mappings == nil {
			cfg.Mappings = map[string]acroform.Mapping{}
		}
		fields, err := loadFieldSpecs(ctx, r.DB, templateID)
		if err != nil {
			return nil, err
		}
		output, err = acroform.Fill(pdfBytes, fields, cfg.Mappings, data, flatten)
		if err != nil {
			return nil, fmt.Errorf("acroform fill: %w", err)
		}
	case "static":
		widgets, err := loadWidgets(ctx, r.DB, templateID)
		if err != nil {
			return nil, err
		}
		output, err = gstatic.Fill(pdfBytes, widgets, data)
		if err != nil {
			return nil, fmt.Errorf("static fill: %w", err)
		}
	case "html":
		// Source file contains the HTML template (pdfBytes is actually HTML bytes here).
		output, err = ghtml.Render(ctx, string(pdfBytes), data)
		if err != nil {
			return nil, fmt.Errorf("html render: %w", err)
		}
	default:
		return nil, fmt.Errorf("unsupported mode %q", mode)
	}

	outName := strings.TrimSuffix(tplName, filepath.Ext(tplName)) + "-filled-" + time.Now().Format("20060102-150405") + ".pdf"
	var outFileID string
	err = r.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,'application/pdf',$4,'','active') RETURNING id`,
		orgID, userID, outName, len(output),
	).Scan(&outFileID)
	if err != nil {
		return nil, fmt.Errorf("create file row: %w", err)
	}
	outKey := fmt.Sprintf("orgs/%s/outputs/%s/%s", orgID, outFileID, outName)
	if _, err := r.DB.Exec(ctx, `UPDATE files SET storage_key=$1 WHERE id=$2`, outKey, outFileID); err != nil {
		return nil, err
	}
	if err := r.Storage.PutBytes(ctx, outKey, "application/pdf", output); err != nil {
		return nil, fmt.Errorf("upload output: %w", err)
	}

	return &Result{OutputFileID: outFileID, OutputKey: outKey, OutputName: outName, Bytes: len(output)}, nil
}

// PutRaw uploads an already-built byte buffer (e.g. a batch ZIP) and creates a File row.
func (r *Runner) PutRaw(ctx context.Context, orgID, userID, name, mime string, data []byte) (*Result, error) {
	var id string
	err := r.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,$4,$5,'','active') RETURNING id`,
		orgID, userID, name, mime, len(data),
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("orgs/%s/outputs/%s/%s", orgID, id, name)
	if _, err := r.DB.Exec(ctx, `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		return nil, err
	}
	if err := r.Storage.PutBytes(ctx, key, mime, data); err != nil {
		return nil, err
	}
	return &Result{OutputFileID: id, OutputKey: key, OutputName: name, Bytes: len(data)}, nil
}

func loadFieldSpecs(ctx context.Context, db *pgxpool.Pool, tplID string) ([]acroform.FieldSpec, error) {
	rows, err := db.Query(ctx, `SELECT name, type FROM template_fields WHERE template_id=$1`, tplID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []acroform.FieldSpec{}
	for rows.Next() {
		var f acroform.FieldSpec
		if err := rows.Scan(&f.Name, &f.Type); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

func loadWidgets(ctx context.Context, db *pgxpool.Pool, tplID string) ([]gstatic.Widget, error) {
	rows, err := db.Query(ctx,
		`SELECT id, type, page, x, y, w, h, data_key, z_index, props_json
		 FROM template_widgets WHERE template_id=$1 ORDER BY page, z_index`, tplID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gstatic.Widget{}
	for rows.Next() {
		var w gstatic.Widget
		var propsRaw []byte
		if err := rows.Scan(&w.ID, &w.Type, &w.Page, &w.X, &w.Y, &w.W, &w.H, &w.DataKey, &w.ZIndex, &propsRaw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(propsRaw, &w.Props)
		out = append(out, w)
	}
	return out, nil
}
