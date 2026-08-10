package wikigovernance

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// EvidenceReference is the committed pointer to external immutable evidence.
// It intentionally has no location, credential, raw payload, or tool output.
type EvidenceReference struct {
	SchemaVersion         string `json:"schema_version"`
	SourceID              string `json:"source_id"`
	SHA256                string `json:"sha256"`
	ContentClassification string `json:"content_classification"`
	RedactionStatus       string `json:"redaction_status"`
}

// ValidateEvidenceReferenceFile fail-closes malformed references and unknown
// fields, preventing a raw payload from being smuggled into a reference manifest.
func ValidateEvidenceReferenceFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read evidence reference: %w", err)
	}
	return ValidateEvidenceReference(data)
}

// ValidateEvidenceReference validates an already safely-read reference payload.
func ValidateEvidenceReference(data []byte) error {
	var reference EvidenceReference
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&reference); err != nil {
		return fmt.Errorf("decode evidence reference: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("evidence reference must contain exactly one JSON object")
	}
	if reference.SchemaVersion != "evidence-reference/v1" {
		return fmt.Errorf("unsupported evidence reference schema %q", reference.SchemaVersion)
	}
	if !sourceIdentifier.MatchString(reference.SourceID) {
		return fmt.Errorf("invalid source_id")
	}
	if !sha256Digest.MatchString(reference.SHA256) {
		return fmt.Errorf("invalid sha256")
	}
	if reference.ContentClassification != "raw_external" && reference.ContentClassification != "redacted_external" {
		return fmt.Errorf("invalid content_classification")
	}
	switch reference.RedactionStatus {
	case "not_applicable", "redacted", "pending_review":
	default:
		return fmt.Errorf("invalid redaction_status")
	}
	return nil
}
