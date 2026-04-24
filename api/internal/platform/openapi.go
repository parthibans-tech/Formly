package platform

import (
	"encoding/json"
	"net/http"
)

// openapiSpec is the hand-curated OpenAPI 3.1 document we serve from
// `/v1/openapi.json`. Kept in Go so it gets code-review + version bumps
// alongside the handlers it describes. Not exhaustive — focuses on the
// endpoints partners actually want from an API key.
func openapiSpec() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "Drive360 API",
			"version":     "1.0.0",
			"description": "REST API for Drive360. Authenticate with a bearer token: a session JWT for first-party calls, or an API key (prefix `fk_`) for programmatic access.",
			"contact": map[string]any{
				"name": "Drive360 support",
				"url":  "https://formly.dev/docs",
			},
		},
		"servers": []map[string]any{
			{"url": "/", "description": "Current host"},
		},
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"BearerAuth": map[string]any{
					"type":         "http",
					"scheme":       "bearer",
					"bearerFormat": "JWT or fk_ API key",
				},
			},
			"schemas": map[string]any{
				"Error": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"error": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"code":    map[string]any{"type": "string", "example": "invalid_body"},
								"message": map[string]any{"type": "string"},
								"docsUrl": map[string]any{"type": "string"},
							},
						},
					},
				},
				"File": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":        map[string]any{"type": "string", "format": "uuid"},
						"name":      map[string]any{"type": "string"},
						"mime":      map[string]any{"type": "string"},
						"size":      map[string]any{"type": "integer"},
						"folderId":  map[string]any{"type": "string", "format": "uuid", "nullable": true},
						"createdAt": map[string]any{"type": "string", "format": "date-time"},
					},
				},
				"Template": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":        map[string]any{"type": "string", "format": "uuid"},
						"name":      map[string]any{"type": "string"},
						"kind":      map[string]any{"type": "string", "enum": []string{"pdf", "html"}},
						"createdAt": map[string]any{"type": "string", "format": "date-time"},
					},
				},
				"Job": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":           map[string]any{"type": "string", "format": "uuid"},
						"kind":         map[string]any{"type": "string", "enum": []string{"single", "batch"}},
						"status":       map[string]any{"type": "string", "enum": []string{"queued", "running", "completed", "failed"}},
						"total":        map[string]any{"type": "integer"},
						"done":         map[string]any{"type": "integer"},
						"outputFileId": map[string]any{"type": "string", "format": "uuid", "nullable": true},
						"error":        map[string]any{"type": "string", "nullable": true},
					},
				},
			},
		},
		"security": []map[string]any{
			{"BearerAuth": []string{}},
		},
		"paths": map[string]any{
			"/v1/me": map[string]any{
				"get": op("Current user", "me", []string{"Auth"},
					respJSON("200", "The authenticated user")),
			},
			"/v1/files": map[string]any{
				"get": op("List files", "listFiles", []string{"Files"},
					respJSON("200", "Page of files")),
			},
			"/v1/files/{id}": map[string]any{
				"get": opWithPath("Get file metadata", "getFile", []string{"Files"},
					[]map[string]any{pathParam("id", "uuid", "File ID")},
					respRef("200", "File", "#/components/schemas/File")),
				"patch": opWithPath("Rename or move a file", "patchFile", []string{"Files"},
					[]map[string]any{pathParam("id", "uuid", "File ID")},
					respJSON("200", "Updated file")),
				"delete": opWithPath("Move a file to trash", "deleteFile", []string{"Files"},
					[]map[string]any{pathParam("id", "uuid", "File ID")},
					respJSON("200", "Trashed")),
			},
			"/v1/files/{id}/download": map[string]any{
				"get": opWithPath("Get a presigned download URL", "downloadFile", []string{"Files"},
					[]map[string]any{pathParam("id", "uuid", "File ID")},
					respJSON("200", "{downloadUrl}")),
			},
			"/v1/files/upload-url": map[string]any{
				"post": op("Create a presigned upload URL", "createUploadUrl", []string{"Files"},
					respJSON("200", "{uploadUrl, fileId}")),
			},
			"/v1/templates/{id}": map[string]any{
				"get": opWithPath("Get template", "getTemplate", []string{"Templates"},
					[]map[string]any{pathParam("id", "uuid", "Template ID")},
					respRef("200", "Template", "#/components/schemas/Template")),
			},
			"/v1/templates/{id}/generate": map[string]any{
				"post": opWithPath("Generate a document", "generate", []string{"Generate"},
					[]map[string]any{pathParam("id", "uuid", "Template ID")},
					respRef("200", "Job", "#/components/schemas/Job")),
			},
			"/v1/templates/{id}/batch": map[string]any{
				"post": opWithPath("Generate a batch from a CSV/XLSX", "generateBatch", []string{"Generate"},
					[]map[string]any{pathParam("id", "uuid", "Template ID")},
					respRef("202", "Job", "#/components/schemas/Job")),
			},
			"/v1/jobs/{id}": map[string]any{
				"get": opWithPath("Get job status", "getJob", []string{"Generate"},
					[]map[string]any{pathParam("id", "uuid", "Job ID")},
					respRef("200", "Job", "#/components/schemas/Job")),
			},
			"/v1/webhooks": map[string]any{
				"get":  op("List webhooks", "listWebhooks", []string{"Webhooks"}, respJSON("200", "Webhooks")),
				"post": op("Create a webhook", "createWebhook", []string{"Webhooks"}, respJSON("200", "Webhook")),
			},
			"/v1/audit": map[string]any{
				"get": op("List audit events (admin only)", "listAudit", []string{"Audit"},
					respJSON("200", "Audit events")),
			},
			"/v1/ops/summary": map[string]any{
				"get": op("Ops dashboard summary", "opsSummary", []string{"Ops"},
					respJSON("200", "Summary")),
			},
		},
	}
}

// OpenAPIHandler serves /v1/openapi.json (public — the spec itself is not
// secret and docs viewers fetch it without credentials).
func OpenAPIHandler() http.HandlerFunc {
	body, _ := json.Marshal(openapiSpec())
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_, _ = w.Write(body)
	}
}

// --- small helpers keep the big spec map readable ----------------------

func op(summary, id string, tags []string, responses map[string]any) map[string]any {
	return map[string]any{
		"summary":     summary,
		"operationId": id,
		"tags":        tags,
		"responses":   responses,
		"security":    []map[string]any{{"BearerAuth": []string{}}},
	}
}

func opWithPath(summary, id string, tags []string, params []map[string]any, responses map[string]any) map[string]any {
	op := op(summary, id, tags, responses)
	op["parameters"] = params
	return op
}

func pathParam(name, format, desc string) map[string]any {
	return map[string]any{
		"name":        name,
		"in":          "path",
		"required":    true,
		"description": desc,
		"schema":      map[string]any{"type": "string", "format": format},
	}
}

func respJSON(code, desc string) map[string]any {
	return map[string]any{
		code: map[string]any{
			"description": desc,
			"content": map[string]any{
				"application/json": map[string]any{},
			},
		},
		"default": map[string]any{
			"description": "Error",
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": "#/components/schemas/Error"},
				},
			},
		},
	}
}

func respRef(code, desc, ref string) map[string]any {
	return map[string]any{
		code: map[string]any{
			"description": desc,
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": ref},
				},
			},
		},
		"default": map[string]any{
			"description": "Error",
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"$ref": "#/components/schemas/Error"},
				},
			},
		},
	}
}
