// Package queue wraps Asynq with typed task payloads and shared config.
package queue

import (
	"encoding/json"
	"os"

	"github.com/hibiken/asynq"
)

const (
	TaskGenerateOne   = "generate:one"
	TaskGenerateBatch = "generate:batch"
)

// RedisAddr returns the Redis connection string (from env, default to localhost).
func RedisAddr() string {
	if v := os.Getenv("REDIS_ADDR"); v != "" {
		return v
	}
	return "localhost:6379"
}

func ClientOpt() asynq.RedisClientOpt {
	return asynq.RedisClientOpt{Addr: RedisAddr()}
}

// GenerateOnePayload describes a single async generation job.
// The job_id column in generation_jobs is the source of truth for status.
type GenerateOnePayload struct {
	JobID      string                 `json:"jobId"`
	OrgID      string                 `json:"orgId"`
	UserID     string                 `json:"userId"`
	TemplateID string                 `json:"templateId"`
	Data       map[string]interface{} `json:"data"`
	Flatten    bool                   `json:"flatten"`
}

// GenerateBatchPayload references a previously-uploaded CSV via MinIO key.
type GenerateBatchPayload struct {
	JobID      string `json:"jobId"`
	OrgID      string `json:"orgId"`
	UserID     string `json:"userId"`
	TemplateID string `json:"templateId"`
	CSVKey     string `json:"csvKey"`
	OutputName string `json:"outputName"`
}

func NewGenerateOne(p GenerateOnePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskGenerateOne, b, asynq.MaxRetry(3)), nil
}

func NewGenerateBatch(p GenerateBatchPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskGenerateBatch, b, asynq.MaxRetry(1)), nil
}
