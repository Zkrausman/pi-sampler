package deliveryevidence

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	AcceptanceMatrixV2SchemaVersion     = "acceptance-matrix/v2"
	AcceptanceManifestV2SchemaVersion   = "implementation-plan-manifest/v2"
	NormalizedFactsV1Format             = "pi-sampler.delivery-normalized-facts"
	NormalizedFactsV1Version            = 1
	AcceptanceResultV1Format            = "pi-sampler.delivery-acceptance-result"
	AcceptanceResultV1Version           = 1
	AcceptanceV2RequestFormat           = "pi-sampler.delivery-acceptance-v2-request"
	AcceptanceV2RequestVersion          = 1
	ExternalEvidenceInventoryFormat     = "pi-sampler.external-evidence-inventory/v1"
	ExternalEvidenceInventoryVersion    = 1
	maxAcceptanceMatrixV2Bytes          = 2 * 1024 * 1024
	maxAcceptanceV2InventoryReportBytes = 2 * 1024 * 1024
	maxAcceptancePlanV2Bytes            = 4 * 1024 * 1024
	maxAcceptanceDefaultStringBytes     = 2048
	maxAcceptanceV2Rows                 = 128
	maxAcceptanceV2Artifacts            = 32
	maxAcceptanceV2Argv                 = 32
	maxAcceptanceV2ArtifactBytes        = 10 * 1024 * 1024
	maxAcceptanceV2EvidenceBytes        = 32 * 1024 * 1024
	maxAcceptanceV2MatrixBytes          = 100 * 1024 * 1024
	maxAcceptanceV2Depth                = 16
	maxAcceptanceV2FutureSkew           = 5 * time.Minute
	maxAcceptanceV2Duration             = 15 * time.Minute
)

var (
	acceptanceV2RevisionRe      = regexp.MustCompile(`^[a-f0-9]{40}(?:[a-f0-9]{24})?$`)
	acceptanceV2DigestRe        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	acceptanceV2TicketRe        = regexp.MustCompile(`^[A-Z][A-Z0-9]+-[0-9]+$`)
	acceptanceV2IdentifierRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$`)
	acceptanceV2RepositoryRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	acceptanceV2OpaqueRootRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	acceptanceV2BlockerCodeRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	acceptanceV2PathComponentRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+,-]*$`)
	acceptanceV2VerifierRe      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]*$`)
)

// AcceptanceMatrixV2 is the strict, additive matrix contract. The custom JSON
// encoder below is intentional: v2 bytes are part of the evidence binding and
// therefore cannot depend on map iteration or Go's field layout decisions.
type AcceptanceMatrixV2 struct {
	SchemaVersion           string                  `json:"schema_version"`
	ManifestSchemaVersion   string                  `json:"manifest_schema_version"`
	EvaluationScope         string                  `json:"evaluation_scope"`
	Repository              string                  `json:"repository"`
	TicketID                string                  `json:"ticket_id"`
	TicketRevision          string                  `json:"ticket_revision"`
	ProfilePath             string                  `json:"profile_path"`
	ProfileSHA256           string                  `json:"profile_sha256"`
	BaseSHA                 string                  `json:"base_sha"`
	HeadSHA                 string                  `json:"head_sha"`
	PullRequestNumber       int                     `json:"pull_request_number"`
	PlanPath                string                  `json:"plan_path"`
	PlanSHA256              string                  `json:"plan_sha256"`
	ManifestPath            string                  `json:"manifest_path"`
	ManifestSHA256          string                  `json:"manifest_sha256"`
	ManifestContractPath    string                  `json:"manifest_contract_path"`
	ManifestContractSHA256  string                  `json:"manifest_contract_sha256"`
	ManifestValidatorPath   string                  `json:"manifest_validator_path"`
	ManifestValidatorSHA256 string                  `json:"manifest_validator_sha256"`
	MatrixContractPath      string                  `json:"matrix_contract_path"`
	MatrixContractSHA256    string                  `json:"matrix_contract_sha256"`
	PolicyPath              string                  `json:"policy_path"`
	PolicySHA256            string                  `json:"policy_sha256"`
	EvidenceRootID          string                  `json:"evidence_root_id"`
	GeneratedAt             string                  `json:"generated_at"`
	Rows                    []AcceptanceMatrixV2Row `json:"rows"`
}

type AcceptanceMatrixV2Row struct {
	ID              string                `json:"id"`
	AcceptanceClass string                `json:"acceptance_class"`
	Requirement     string                `json:"requirement"`
	Status          string                `json:"status"`
	Specification   *AcceptanceEvidenceV2 `json:"specification,omitempty"`
	Evidence        *AcceptanceEvidenceV2 `json:"evidence,omitempty"`
	Blocker         *AcceptanceBlockerV2  `json:"blocker,omitempty"`
}

type AcceptanceEvidenceV2 struct {
	Verifier    AcceptanceVerifierV2   `json:"verifier"`
	ExitStatus  int                    `json:"exit_status"`
	StartedAt   string                 `json:"started_at"`
	CompletedAt string                 `json:"completed_at"`
	Artifacts   []AcceptanceArtifactV2 `json:"artifacts"`
}

type AcceptanceVerifierV2 struct {
	ID          string   `json:"id"`
	Version     string   `json:"version"`
	Environment string   `json:"environment"`
	Argv        []string `json:"argv"`
}

type AcceptanceArtifactV2 struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type AcceptanceBlockerV2 struct {
	Code      string  `json:"code"`
	Reason    string  `json:"reason"`
	BlockedBy *string `json:"blocked_by"`
}

type NormalizedFactsV1 struct {
	Format                  string                 `json:"format"`
	Version                 int                    `json:"version"`
	Repository              string                 `json:"repository"`
	TicketID                string                 `json:"ticketId"`
	TicketRevision          string                 `json:"ticketRevision"`
	ProfilePath             string                 `json:"profilePath"`
	ProfileSHA256           string                 `json:"profileSha256"`
	BaseSHA                 string                 `json:"baseSha"`
	HeadSHA                 string                 `json:"headSha"`
	PullRequestNumber       int                    `json:"pullRequestNumber"`
	PlanPath                string                 `json:"planPath"`
	PlanSHA256              string                 `json:"planSha256"`
	ManifestPath            string                 `json:"manifestPath"`
	ManifestSHA256          string                 `json:"manifestSha256"`
	ManifestSchemaVersion   string                 `json:"manifestSchemaVersion"`
	ManifestContractSHA256  string                 `json:"manifestContractSha256"`
	ManifestValidatorSHA256 string                 `json:"manifestValidatorSha256"`
	MatrixContractSHA256    string                 `json:"matrixContractSha256"`
	PolicySHA256            string                 `json:"policySha256"`
	EvaluationScope         string                 `json:"evaluationScope"`
	Rows                    []NormalizedFactsV1Row `json:"rows"`
}

type NormalizedFactsV1Row struct {
	ID              string `json:"id"`
	AcceptanceClass string `json:"acceptanceClass"`
	Requirement     string `json:"requirement"`
}

type NormalizedFactsRowV1 = NormalizedFactsV1Row
type AcceptanceRowResultV1 = AcceptanceResultV1Row

type AcceptanceResultV1 struct {
	Format          string                   `json:"format"`
	Version         int                      `json:"version"`
	Status          string                   `json:"status"`
	Code            string                   `json:"code"`
	EvaluationScope string                   `json:"evaluation_scope"`
	FactsSHA256     string                   `json:"facts_sha256"`
	MatrixSHA256    string                   `json:"matrix_sha256"`
	Rows            []AcceptanceResultV1Row  `json:"rows"`
	Diagnostics     []AcceptanceDiagnosticV1 `json:"diagnostics"`
}

type AcceptanceResultV1Row struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Code   string `json:"code"`
}

type AcceptanceDiagnosticV1 struct {
	Code string `json:"code"`
	Path string `json:"path"`
}

// AcceptancePolicyV2 is the portion of profiles/pi-sampler.json consumed by
// the v2 evaluator. The profile has additional policy fields; they remain
// opaque to this evaluator and are never treated as acceptance evidence.
type AcceptancePolicyV2 struct {
	Classes []AcceptanceClassPolicyV2 `json:"classes"`
}

type AcceptanceClassPolicyV2 struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Verifier    string   `json:"verifier"`
	Environment string   `json:"environment"`
	Command     []string `json:"command"`
	Version     string   `json:"version,omitempty"`
}

type AcceptanceV2Request struct {
	Format          string            `json:"format"`
	Version         int               `json:"version"`
	NormalizedFacts NormalizedFactsV1 `json:"normalized_facts"`
	FactsSHA256     string            `json:"facts_sha256"`
	MatrixBase64    string            `json:"matrix_base64"`
	EvidenceRoot    string            `json:"evidence_root"`
	Policy          json.RawMessage   `json:"policy"`
	ControllerTime  string            `json:"controller_time"`
}

// DecodeAcceptanceV2Request performs the bounded duplicate-key/unknown-field
// parse used by the stdin CLI. The outer framing limit is intentionally larger
// than the matrix limit because base64 and policy envelopes add overhead.
func DecodeAcceptanceV2Request(data []byte) (AcceptanceV2Request, error) {
	var request AcceptanceV2Request
	if len(data) == 0 || len(data) > 12*1024*1024 || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return request, errors.New("acceptance-v2 request exceeds limit or is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	budget := &jsonBudget{}
	if err := scanJSONValue(decoder, 0, budget); err != nil {
		return request, err
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return request, errors.New("acceptance-v2 request has trailing data")
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return request, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return request, errors.New("acceptance-v2 request has multiple frames")
	}
	return request, nil
}

type acceptanceV2Diagnostic struct {
	Code string
	Path string
}

type acceptanceV2Diagnostics struct {
	items map[string]acceptanceV2Diagnostic
}

var acceptanceV2Precedence = map[string]int{
	"usage_invalid":                1,
	"git_unavailable":              2,
	"trusted_base_invalid":         3,
	"activation_absent":            4,
	"trusted_blob_invalid":         5,
	"trusted_digest_mismatch":      6,
	"candidate_root_invalid":       7,
	"source_mutated":               8,
	"artifact_too_large":           9,
	"manifest_validator_failed":    10,
	"manifest_version_unsupported": 11,
	"matrix_duplicate_key":         12,
	"matrix_json_invalid":          13,
	"matrix_schema_invalid":        14,
	"matrix_noncanonical":          15,
	"version_pair_mixed":           16,
	"version_pair_unsupported":     17,
	"binding_mismatch":             18,
	"artifact_path_mismatch":       19,
	"digest_mismatch":              20,
	"row_duplicate":                21,
	"row_missing":                  22,
	"row_unknown":                  23,
	"row_reordered":                24,
	"row_binding_mismatch":         25,
	"scope_status_mismatch":        26,
	"evidence_root_invalid":        27,
	"evidence_path_invalid":        28,
	"evidence_identity_changed":    29,
	"artifact_digest_mismatch":     30,
	"policy_missing":               31,
	"policy_ambiguous":             32,
	"verifier_policy_mismatch":     33,
	"unsupported_class_policy":     34,
	"rows_blocked":                 35,
}

func newAcceptanceV2Diagnostics() *acceptanceV2Diagnostics {
	return &acceptanceV2Diagnostics{items: make(map[string]acceptanceV2Diagnostic)}
}

func (d *acceptanceV2Diagnostics) add(code, path string) {
	if _, ok := acceptanceV2Precedence[code]; !ok {
		code = "matrix_schema_invalid"
	}
	if path == "" || !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\r\n\t") {
		path = "/matrix"
	}
	key := code + "\x00" + path
	d.items[key] = acceptanceV2Diagnostic{Code: code, Path: path}
}

func (d *acceptanceV2Diagnostics) sorted() []AcceptanceDiagnosticV1 {
	items := make([]acceptanceV2Diagnostic, 0, len(d.items))
	for _, item := range d.items {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		pi, pj := acceptanceV2Precedence[items[i].Code], acceptanceV2Precedence[items[j].Code]
		if pi != pj {
			return pi < pj
		}
		if items[i].Path != items[j].Path {
			return items[i].Path < items[j].Path
		}
		return items[i].Code < items[j].Code
	})
	if len(items) > 128 {
		items = items[:128]
	}
	result := make([]AcceptanceDiagnosticV1, len(items))
	for i, item := range items {
		result[i] = AcceptanceDiagnosticV1{Code: item.Code, Path: item.Path}
	}
	return result
}

func (d *acceptanceV2Diagnostics) has(code string) bool {
	for _, item := range d.items {
		if item.Code == code {
			return true
		}
	}
	return false
}

func (d *acceptanceV2Diagnostics) firstCode() string {
	items := d.sorted()
	if len(items) == 0 {
		return "valid"
	}
	return items[0].Code
}

var (
	errV2DuplicateKey  = errors.New("matrix_duplicate_key")
	errV2JSONInvalid   = errors.New("matrix_json_invalid")
	errV2TrailingValue = errors.New("matrix_noncanonical")
)

// scanAcceptanceV2JSON checks duplicate keys and bounded nesting before the
// typed decoder is allowed to construct the matrix. It intentionally accepts
// ordinary JSON whitespace; canonical byte comparison is a later, separate
// decision with its specified precedence.
func scanAcceptanceV2JSON(data []byte) error {
	if len(data) == 0 || len(data) > maxAcceptanceMatrixV2Bytes || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return errV2JSONInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var nodes int
	var scan func(int) error
	scan = func(depth int) error {
		if depth > maxAcceptanceV2Depth || nodes > 100_000 {
			return errV2JSONInvalid
		}
		nodes++
		token, err := decoder.Token()
		if err != nil {
			return errV2JSONInvalid
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return errV2JSONInvalid
				}
				name, ok := key.(string)
				if !ok {
					return errV2JSONInvalid
				}
				if _, exists := seen[name]; exists {
					return errV2DuplicateKey
				}
				seen[name] = struct{}{}
				if err := scan(depth + 1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return errV2JSONInvalid
			}
		case '[':
			count := 0
			for decoder.More() {
				count++
				if count > maxAcceptanceV2Rows*maxAcceptanceV2Artifacts {
					return errV2JSONInvalid
				}
				if err := scan(depth + 1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return errV2JSONInvalid
			}
		}
		return nil
	}
	if scanErr := scan(0); scanErr != nil {
		return scanErr
	}
	var trailing any
	trailingErr := decoder.Decode(&trailing)
	if trailingErr == nil {
		return errV2TrailingValue
	}
	if trailingErr != io.EOF {
		return errV2JSONInvalid
	}
	return nil
}

func requiredJSONMembers(object map[string]json.RawMessage, members ...string) bool {
	for _, member := range members {
		value, ok := object[member]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}

func acceptanceV2RawShapeValid(data []byte, matrix AcceptanceMatrixV2) bool {
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil {
		return false
	}
	rootMembers := []string{"schema_version", "manifest_schema_version", "evaluation_scope", "repository", "ticket_id", "ticket_revision", "profile_path", "profile_sha256", "base_sha", "head_sha", "pull_request_number", "plan_path", "plan_sha256", "manifest_path", "manifest_sha256", "manifest_contract_path", "manifest_contract_sha256", "manifest_validator_path", "manifest_validator_sha256", "matrix_contract_path", "matrix_contract_sha256", "policy_path", "policy_sha256", "evidence_root_id", "generated_at", "rows"}
	if !requiredJSONMembers(root, rootMembers...) {
		return false
	}
	var rawRows []map[string]json.RawMessage
	if json.Unmarshal(root["rows"], &rawRows) != nil || len(rawRows) != len(matrix.Rows) {
		return false
	}
	for index, rawRow := range rawRows {
		if !requiredJSONMembers(rawRow, "id", "acceptance_class", "requirement", "status") {
			return false
		}
		status := matrix.Rows[index].Status
		_, hasSpecification := rawRow["specification"]
		_, hasEvidence := rawRow["evidence"]
		_, hasBlocker := rawRow["blocker"]
		if matrix.EvaluationScope == "plan-publication" {
			if !requiredJSONMembers(rawRow, "specification") || hasEvidence || hasBlocker {
				return false
			}
		} else if status == "observed" {
			if !requiredJSONMembers(rawRow, "evidence") || hasSpecification || hasBlocker {
				return false
			}
		} else if status == "blocked" {
			if !requiredJSONMembers(rawRow, "blocker") || hasSpecification || hasEvidence {
				return false
			}
		} else {
			return false
		}
		for _, field := range []string{"specification", "evidence"} {
			if raw, ok := rawRow[field]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				var evidence map[string]json.RawMessage
				if json.Unmarshal(raw, &evidence) != nil || !requiredJSONMembers(evidence, "verifier", "exit_status", "started_at", "completed_at", "artifacts") {
					return false
				}
				var verifier map[string]json.RawMessage
				if json.Unmarshal(evidence["verifier"], &verifier) != nil || !requiredJSONMembers(verifier, "id", "version", "environment", "argv") {
					return false
				}
				var artifacts []map[string]json.RawMessage
				if json.Unmarshal(evidence["artifacts"], &artifacts) != nil {
					return false
				}
				for _, artifact := range artifacts {
					if !requiredJSONMembers(artifact, "name", "path", "sha256", "bytes") {
						return false
					}
				}
			}
		}
		if raw, ok := rawRow["blocker"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			var blocker map[string]json.RawMessage
			if json.Unmarshal(raw, &blocker) != nil || !requiredJSONMembers(blocker, "code", "reason") {
				return false
			}
			if _, present := blocker["blocked_by"]; !present {
				return false
			}
		}
	}
	return true
}

func decodeAcceptanceMatrixV2(data []byte) (AcceptanceMatrixV2, string) {
	if err := scanAcceptanceV2JSON(data); err != nil {
		switch err {
		case errV2DuplicateKey:
			return AcceptanceMatrixV2{}, "matrix_duplicate_key"
		case errV2TrailingValue:
			return AcceptanceMatrixV2{}, "matrix_noncanonical"
		default:
			return AcceptanceMatrixV2{}, "matrix_json_invalid"
		}
	}
	var matrix AcceptanceMatrixV2
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&matrix); err != nil {
		return AcceptanceMatrixV2{}, "matrix_schema_invalid"
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return AcceptanceMatrixV2{}, "matrix_noncanonical"
	}
	if !acceptanceV2RawShapeValid(data, matrix) {
		return AcceptanceMatrixV2{}, "matrix_schema_invalid"
	}
	if !isCanonicalAcceptanceMatrixV2(data, matrix) {
		return AcceptanceMatrixV2{}, "matrix_noncanonical"
	}
	return matrix, ""
}

func jsonBytes(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func appendJSONField(buffer *bytes.Buffer, first *bool, name string, value []byte) {
	if !*first {
		buffer.WriteByte(',')
	}
	*first = false
	key, _ := jsonBytes(name)
	buffer.Write(key)
	buffer.WriteByte(':')
	buffer.Write(value)
}

func canonicalV2JSONString(value string) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('"')
	const hexDigits = "0123456789abcdef"
	for _, r := range value {
		switch r {
		case '"':
			buffer.WriteString(`\"`)
		case '\\':
			buffer.WriteString(`\\`)
		case '\b':
			buffer.WriteString(`\b`)
		case '\f':
			buffer.WriteString(`\f`)
		case '\n':
			buffer.WriteString(`\n`)
		case '\r':
			buffer.WriteString(`\r`)
		case '\t':
			buffer.WriteString(`\t`)
		default:
			if r < 0x20 {
				buffer.WriteString(`\u00`)
				buffer.WriteByte(hexDigits[(r>>4)&0xf])
				buffer.WriteByte(hexDigits[r&0xf])
			} else {
				buffer.WriteRune(r)
			}
		}
	}
	buffer.WriteByte('"')
	return buffer.Bytes()
}

func appendJSONStringField(buffer *bytes.Buffer, first *bool, name, value string) {
	appendJSONField(buffer, first, name, canonicalV2JSONString(value))
}

func appendJSONIntField(buffer *bytes.Buffer, first *bool, name string, value int64) {
	appendJSONField(buffer, first, name, []byte(strconv.FormatInt(value, 10)))
}

func appendJSONIntNativeField(buffer *bytes.Buffer, first *bool, name string, value int) {
	appendJSONField(buffer, first, name, []byte(strconv.Itoa(value)))
}

func canonicalAcceptanceVerifierBytes(verifier AcceptanceVerifierV2) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "id", verifier.ID)
	appendJSONStringField(&buffer, &first, "version", verifier.Version)
	appendJSONStringField(&buffer, &first, "environment", verifier.Environment)
	var argv bytes.Buffer
	argv.WriteByte('[')
	for index, value := range verifier.Argv {
		if index > 0 {
			argv.WriteByte(',')
		}
		argv.Write(canonicalV2JSONString(value))
	}
	argv.WriteByte(']')
	appendJSONField(&buffer, &first, "argv", argv.Bytes())
	buffer.WriteByte('}')
	return buffer.Bytes()
}

func canonicalAcceptanceArtifactBytes(artifact AcceptanceArtifactV2) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "name", artifact.Name)
	appendJSONStringField(&buffer, &first, "path", artifact.Path)
	appendJSONStringField(&buffer, &first, "sha256", artifact.SHA256)
	appendJSONIntField(&buffer, &first, "bytes", artifact.Bytes)
	buffer.WriteByte('}')
	return buffer.Bytes()
}

func canonicalAcceptanceEvidenceBytes(evidence AcceptanceEvidenceV2) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONField(&buffer, &first, "verifier", canonicalAcceptanceVerifierBytes(evidence.Verifier))
	appendJSONIntNativeField(&buffer, &first, "exit_status", evidence.ExitStatus)
	appendJSONStringField(&buffer, &first, "started_at", evidence.StartedAt)
	appendJSONStringField(&buffer, &first, "completed_at", evidence.CompletedAt)
	artifacts := make([][]byte, len(evidence.Artifacts))
	for i, artifact := range evidence.Artifacts {
		artifacts[i] = canonicalAcceptanceArtifactBytes(artifact)
	}
	var list bytes.Buffer
	list.WriteByte('[')
	for i, item := range artifacts {
		if i > 0 {
			list.WriteByte(',')
		}
		list.Write(item)
	}
	list.WriteByte(']')
	appendJSONField(&buffer, &first, "artifacts", list.Bytes())
	buffer.WriteByte('}')
	return buffer.Bytes()
}

func canonicalAcceptanceBlockerBytes(blocker AcceptanceBlockerV2) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "code", blocker.Code)
	appendJSONStringField(&buffer, &first, "reason", blocker.Reason)
	if blocker.BlockedBy == nil {
		appendJSONField(&buffer, &first, "blocked_by", []byte("null"))
	} else {
		appendJSONStringField(&buffer, &first, "blocked_by", *blocker.BlockedBy)
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

func canonicalAcceptanceRowBytes(row AcceptanceMatrixV2Row, scope string) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "id", row.ID)
	appendJSONStringField(&buffer, &first, "acceptance_class", row.AcceptanceClass)
	appendJSONStringField(&buffer, &first, "requirement", row.Requirement)
	appendJSONStringField(&buffer, &first, "status", row.Status)
	if scope == "plan-publication" {
		if row.Specification == nil {
			appendJSONField(&buffer, &first, "specification", []byte("null"))
		} else {
			appendJSONField(&buffer, &first, "specification", canonicalAcceptanceEvidenceBytes(*row.Specification))
		}
	} else if row.Evidence != nil {
		// Keep a present evidence member in the canonical projection even when
		// its status is wrong, so status mutations reach semantic validation.
		appendJSONField(&buffer, &first, "evidence", canonicalAcceptanceEvidenceBytes(*row.Evidence))
	} else if row.Blocker != nil {
		appendJSONField(&buffer, &first, "blocker", canonicalAcceptanceBlockerBytes(*row.Blocker))
	} else if row.Status == "observed" {
		appendJSONField(&buffer, &first, "evidence", []byte("null"))
	} else if row.Status == "blocked" {
		appendJSONField(&buffer, &first, "blocker", []byte("null"))
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

func canonicalAcceptanceMatrixV2Bytes(matrix AcceptanceMatrixV2) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "schema_version", matrix.SchemaVersion)
	appendJSONStringField(&buffer, &first, "manifest_schema_version", matrix.ManifestSchemaVersion)
	appendJSONStringField(&buffer, &first, "evaluation_scope", matrix.EvaluationScope)
	appendJSONStringField(&buffer, &first, "repository", matrix.Repository)
	appendJSONStringField(&buffer, &first, "ticket_id", matrix.TicketID)
	appendJSONStringField(&buffer, &first, "ticket_revision", matrix.TicketRevision)
	appendJSONStringField(&buffer, &first, "profile_path", matrix.ProfilePath)
	appendJSONStringField(&buffer, &first, "profile_sha256", matrix.ProfileSHA256)
	appendJSONStringField(&buffer, &first, "base_sha", matrix.BaseSHA)
	appendJSONStringField(&buffer, &first, "head_sha", matrix.HeadSHA)
	appendJSONIntNativeField(&buffer, &first, "pull_request_number", matrix.PullRequestNumber)
	appendJSONStringField(&buffer, &first, "plan_path", matrix.PlanPath)
	appendJSONStringField(&buffer, &first, "plan_sha256", matrix.PlanSHA256)
	appendJSONStringField(&buffer, &first, "manifest_path", matrix.ManifestPath)
	appendJSONStringField(&buffer, &first, "manifest_sha256", matrix.ManifestSHA256)
	appendJSONStringField(&buffer, &first, "manifest_contract_path", matrix.ManifestContractPath)
	appendJSONStringField(&buffer, &first, "manifest_contract_sha256", matrix.ManifestContractSHA256)
	appendJSONStringField(&buffer, &first, "manifest_validator_path", matrix.ManifestValidatorPath)
	appendJSONStringField(&buffer, &first, "manifest_validator_sha256", matrix.ManifestValidatorSHA256)
	appendJSONStringField(&buffer, &first, "matrix_contract_path", matrix.MatrixContractPath)
	appendJSONStringField(&buffer, &first, "matrix_contract_sha256", matrix.MatrixContractSHA256)
	appendJSONStringField(&buffer, &first, "policy_path", matrix.PolicyPath)
	appendJSONStringField(&buffer, &first, "policy_sha256", matrix.PolicySHA256)
	appendJSONStringField(&buffer, &first, "evidence_root_id", matrix.EvidenceRootID)
	appendJSONStringField(&buffer, &first, "generated_at", matrix.GeneratedAt)
	rows := make([][]byte, len(matrix.Rows))
	for i, row := range matrix.Rows {
		rows[i] = canonicalAcceptanceRowBytes(row, matrix.EvaluationScope)
	}
	var list bytes.Buffer
	list.WriteByte('[')
	for i, row := range rows {
		if i > 0 {
			list.WriteByte(',')
		}
		list.Write(row)
	}
	list.WriteByte(']')
	appendJSONField(&buffer, &first, "rows", list.Bytes())
	buffer.WriteByte('}')
	buffer.WriteByte('\n')
	return buffer.Bytes()
}

func isCanonicalAcceptanceMatrixV2(data []byte, matrix AcceptanceMatrixV2) bool {
	return bytes.Equal(data, canonicalAcceptanceMatrixV2Bytes(matrix))
}

func canonicalNormalizedFactsV1Bytes(facts NormalizedFactsV1) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "format", facts.Format)
	appendJSONIntNativeField(&buffer, &first, "version", facts.Version)
	appendJSONStringField(&buffer, &first, "repository", facts.Repository)
	appendJSONStringField(&buffer, &first, "ticketId", facts.TicketID)
	appendJSONStringField(&buffer, &first, "ticketRevision", facts.TicketRevision)
	appendJSONStringField(&buffer, &first, "profilePath", facts.ProfilePath)
	appendJSONStringField(&buffer, &first, "profileSha256", facts.ProfileSHA256)
	appendJSONStringField(&buffer, &first, "baseSha", facts.BaseSHA)
	appendJSONStringField(&buffer, &first, "headSha", facts.HeadSHA)
	appendJSONIntNativeField(&buffer, &first, "pullRequestNumber", facts.PullRequestNumber)
	appendJSONStringField(&buffer, &first, "planPath", facts.PlanPath)
	appendJSONStringField(&buffer, &first, "planSha256", facts.PlanSHA256)
	appendJSONStringField(&buffer, &first, "manifestPath", facts.ManifestPath)
	appendJSONStringField(&buffer, &first, "manifestSha256", facts.ManifestSHA256)
	appendJSONStringField(&buffer, &first, "manifestSchemaVersion", facts.ManifestSchemaVersion)
	appendJSONStringField(&buffer, &first, "manifestContractSha256", facts.ManifestContractSHA256)
	appendJSONStringField(&buffer, &first, "manifestValidatorSha256", facts.ManifestValidatorSHA256)
	appendJSONStringField(&buffer, &first, "matrixContractSha256", facts.MatrixContractSHA256)
	appendJSONStringField(&buffer, &first, "policySha256", facts.PolicySHA256)
	appendJSONStringField(&buffer, &first, "evaluationScope", facts.EvaluationScope)
	rows := make([][]byte, len(facts.Rows))
	for i, row := range facts.Rows {
		var item bytes.Buffer
		item.WriteByte('{')
		itemFirst := true
		appendJSONStringField(&item, &itemFirst, "id", row.ID)
		appendJSONStringField(&item, &itemFirst, "acceptanceClass", row.AcceptanceClass)
		appendJSONStringField(&item, &itemFirst, "requirement", row.Requirement)
		item.WriteByte('}')
		rows[i] = item.Bytes()
	}
	var list bytes.Buffer
	list.WriteByte('[')
	for i, row := range rows {
		if i > 0 {
			list.WriteByte(',')
		}
		list.Write(row)
	}
	list.WriteByte(']')
	appendJSONField(&buffer, &first, "rows", list.Bytes())
	buffer.WriteByte('}')
	buffer.WriteByte('\n')
	return buffer.Bytes()
}

// CanonicalNormalizedFactsV1 returns the exact JSON bytes (including the one
// required LF) used by the domain-separated facts digest.
func CanonicalNormalizedFactsV1(facts NormalizedFactsV1) []byte {
	return canonicalNormalizedFactsV1Bytes(facts)
}

func NormalizedFactsSHA256V1(facts NormalizedFactsV1) string { return normalizedFactsDigestV1(facts) }

func CanonicalAcceptanceMatrixV2(matrix AcceptanceMatrixV2) []byte {
	return canonicalAcceptanceMatrixV2Bytes(matrix)
}
func CanonicalAcceptanceResultV1(result AcceptanceResultV1) []byte {
	return canonicalAcceptanceResultV1Bytes(result)
}

func normalizedFactsDigestV1(facts NormalizedFactsV1) string {
	prefix := []byte("pi-sampler.delivery-normalized-facts/v1\x00")
	hash := sha256.Sum256(append(prefix, canonicalNormalizedFactsV1Bytes(facts)...))
	return hex.EncodeToString(hash[:])
}

func canonicalAcceptanceResultV1Bytes(result AcceptanceResultV1) []byte {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "format", result.Format)
	appendJSONIntNativeField(&buffer, &first, "version", result.Version)
	appendJSONStringField(&buffer, &first, "status", result.Status)
	appendJSONStringField(&buffer, &first, "code", result.Code)
	appendJSONStringField(&buffer, &first, "evaluation_scope", result.EvaluationScope)
	appendJSONStringField(&buffer, &first, "facts_sha256", result.FactsSHA256)
	appendJSONStringField(&buffer, &first, "matrix_sha256", result.MatrixSHA256)
	rows := make([][]byte, len(result.Rows))
	for i, row := range result.Rows {
		var item bytes.Buffer
		item.WriteByte('{')
		itemFirst := true
		appendJSONStringField(&item, &itemFirst, "id", row.ID)
		appendJSONStringField(&item, &itemFirst, "status", row.Status)
		appendJSONStringField(&item, &itemFirst, "code", row.Code)
		item.WriteByte('}')
		rows[i] = item.Bytes()
	}
	var rowList bytes.Buffer
	rowList.WriteByte('[')
	for i, row := range rows {
		if i > 0 {
			rowList.WriteByte(',')
		}
		rowList.Write(row)
	}
	rowList.WriteByte(']')
	appendJSONField(&buffer, &first, "rows", rowList.Bytes())
	diagnostics := make([][]byte, len(result.Diagnostics))
	for i, diagnostic := range result.Diagnostics {
		var item bytes.Buffer
		item.WriteByte('{')
		itemFirst := true
		appendJSONStringField(&item, &itemFirst, "code", diagnostic.Code)
		appendJSONStringField(&item, &itemFirst, "path", diagnostic.Path)
		item.WriteByte('}')
		diagnostics[i] = item.Bytes()
	}
	var diagnosticList bytes.Buffer
	diagnosticList.WriteByte('[')
	for i, diagnostic := range diagnostics {
		if i > 0 {
			diagnosticList.WriteByte(',')
		}
		diagnosticList.Write(diagnostic)
	}
	diagnosticList.WriteByte(']')
	appendJSONField(&buffer, &first, "diagnostics", diagnosticList.Bytes())
	buffer.WriteByte('}')
	buffer.WriteByte('\n')
	return buffer.Bytes()
}

func (r AcceptanceResultV1) MarshalJSON() ([]byte, error) {
	return bytes.TrimSuffix(canonicalAcceptanceResultV1Bytes(r), []byte{'\n'}), nil
}
func (m AcceptanceMatrixV2) MarshalJSON() ([]byte, error) {
	return bytes.TrimSuffix(canonicalAcceptanceMatrixV2Bytes(m), []byte{'\n'}), nil
}

func validV2DefaultString(value string, maximum int) bool {
	if value == "" || !utf8.ValidString(value) || len([]byte(value)) > maximum {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func validV2ASCII(value string, maximum int) bool {
	return acceptanceV2VerifierRe.MatchString(value) && validV2DefaultString(value, maximum)
}

func validV2ArtifactName(value string) bool {
	return validV2DefaultString(value, 128)
}

func validV2Revision(value string) bool { return acceptanceV2RevisionRe.MatchString(value) }
func validV2Digest(value string) bool   { return acceptanceV2DigestRe.MatchString(value) }
func validV2Identifier(value string) bool {
	return acceptanceV2IdentifierRe.MatchString(value) && len([]byte(value)) <= 128
}

func validV2PortablePath(value string, maximum int) bool {
	if !validV2DefaultString(value, maximum) || strings.ContainsAny(value, `\\%:`) || strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.Contains(value, "//") {
		return false
	}
	if acceptanceV2WindowsDriveRe.MatchString(value) {
		return false
	}
	parts := strings.Split(value, "/")
	if len(parts) == 0 {
		return false
	}
	for _, part := range parts {
		if len([]byte(part)) > 255 || part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || !validV2PathComponent(part) {
			return false
		}
	}
	return true
}

var acceptanceV2WindowsDriveRe = regexp.MustCompile(`^[A-Za-z]:`)

func validV2PathComponent(value string) bool {
	if value == "" || !acceptanceV2PathComponentRe.MatchString(value) {
		return false
	}
	for _, component := range strings.Split(value, "/") {
		upper := strings.ToUpper(strings.SplitN(component, ".", 2)[0])
		switch upper {
		case "CON", "PRN", "AUX", "NUL", "CLOCK$":
			return false
		}
		if len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9' {
			return false
		}
	}
	return true
}

func validV2ArtifactPath(value string) bool {
	if !validV2PortablePath(value, 240) {
		return false
	}
	return len(strings.Split(value, "/")) <= externalRootMaxDepth
}

func parseV2Timestamp(value string) (time.Time, bool) {
	if len(value) != 24 || !regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`).MatchString(value) {
		return time.Time{}, false
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	return parsed.UTC(), err == nil && parsed.UTC().Format("2006-01-02T15:04:05.000Z") == value
}

func siblingManifestPath(planPath string) string {
	const suffix = "-implementation-plan.md"
	if !strings.HasSuffix(planPath, suffix) {
		return ""
	}
	return strings.TrimSuffix(planPath, suffix) + "-acceptance-manifest-v2.json"
}

func validateNormalizedFactsV1Shape(facts NormalizedFactsV1, diagnostics *acceptanceV2Diagnostics) {
	if facts.Format != NormalizedFactsV1Format || facts.Version != NormalizedFactsV1Version {
		diagnostics.add("binding_mismatch", "/normalized_facts")
	}
	if !acceptanceV2RepositoryRe.MatchString(facts.Repository) || len([]byte(facts.Repository)) > 256 {
		diagnostics.add("binding_mismatch", "/normalized_facts/repository")
	}
	if !acceptanceV2TicketRe.MatchString(facts.TicketID) || len([]byte(facts.TicketID)) > 32 {
		diagnostics.add("binding_mismatch", "/normalized_facts/ticketId")
	}
	if !validV2Revision(facts.TicketRevision) || !validV2Revision(facts.BaseSHA) || !validV2Revision(facts.HeadSHA) || facts.BaseSHA == facts.HeadSHA {
		diagnostics.add("binding_mismatch", "/normalized_facts/baseSha")
	}
	if facts.ProfilePath != "profiles/pi-sampler.json" || !validV2Digest(facts.ProfileSHA256) || facts.PolicySHA256 != facts.ProfileSHA256 {
		diagnostics.add("binding_mismatch", "/normalized_facts/profilePath")
	}
	if facts.ManifestSchemaVersion != AcceptanceManifestV2SchemaVersion || !validV2Digest(facts.PlanSHA256) || !validV2Digest(facts.ManifestSHA256) || !validV2Digest(facts.ManifestContractSHA256) || !validV2Digest(facts.ManifestValidatorSHA256) || !validV2Digest(facts.MatrixContractSHA256) {
		diagnostics.add("binding_mismatch", "/normalized_facts/digests")
	}
	if !validV2PortablePath(facts.PlanPath, 256) || !validV2PortablePath(facts.ManifestPath, 256) || facts.ManifestPath != siblingManifestPath(facts.PlanPath) {
		diagnostics.add("binding_mismatch", "/normalized_facts/planPath")
	}
	if facts.PullRequestNumber < 1 || facts.PullRequestNumber > 1_000_000_000 {
		diagnostics.add("binding_mismatch", "/normalized_facts/pullRequestNumber")
	}
	if facts.EvaluationScope != "plan-publication" && facts.EvaluationScope != "implementation-delivery" {
		diagnostics.add("binding_mismatch", "/normalized_facts/evaluationScope")
	}
	if len(facts.Rows) < 1 || len(facts.Rows) > maxAcceptanceV2Rows {
		diagnostics.add("binding_mismatch", "/normalized_facts/rows")
	}
	seen := make(map[string]bool, len(facts.Rows))
	for index, row := range facts.Rows {
		if !validV2Identifier(row.ID) || !validV2DefaultString(row.AcceptanceClass, 64) || !validV2DefaultString(row.Requirement, maxAcceptanceDefaultStringBytes) {
			diagnostics.add("binding_mismatch", fmt.Sprintf("/normalized_facts/rows/%d", index))
		}
		if seen[row.ID] {
			diagnostics.add("binding_mismatch", fmt.Sprintf("/normalized_facts/rows/%d/id", index))
		}
		seen[row.ID] = true
	}
}

func validateAcceptanceV2Root(matrix AcceptanceMatrixV2, facts NormalizedFactsV1, diagnostics *acceptanceV2Diagnostics) (time.Time, bool) {
	valid := true
	if matrix.SchemaVersion != AcceptanceMatrixV2SchemaVersion || matrix.ManifestSchemaVersion != AcceptanceManifestV2SchemaVersion {
		diagnostics.add("manifest_version_unsupported", "/schema_version")
		valid = false
	}
	if matrix.EvaluationScope != "plan-publication" && matrix.EvaluationScope != "implementation-delivery" {
		diagnostics.add("matrix_schema_invalid", "/evaluation_scope")
		valid = false
	}
	for _, value := range []struct{ value, path string }{
		{matrix.Repository, "/repository"}, {matrix.TicketID, "/ticket_id"}, {matrix.TicketRevision, "/ticket_revision"}, {matrix.ProfilePath, "/profile_path"}, {matrix.ProfileSHA256, "/profile_sha256"}, {matrix.BaseSHA, "/base_sha"}, {matrix.HeadSHA, "/head_sha"}, {matrix.PlanPath, "/plan_path"}, {matrix.PlanSHA256, "/plan_sha256"}, {matrix.ManifestPath, "/manifest_path"}, {matrix.ManifestSHA256, "/manifest_sha256"}, {matrix.ManifestContractPath, "/manifest_contract_path"}, {matrix.ManifestContractSHA256, "/manifest_contract_sha256"}, {matrix.ManifestValidatorPath, "/manifest_validator_path"}, {matrix.ManifestValidatorSHA256, "/manifest_validator_sha256"}, {matrix.MatrixContractPath, "/matrix_contract_path"}, {matrix.MatrixContractSHA256, "/matrix_contract_sha256"}, {matrix.PolicyPath, "/policy_path"}, {matrix.PolicySHA256, "/policy_sha256"}, {matrix.EvidenceRootID, "/evidence_root_id"}, {matrix.GeneratedAt, "/generated_at"},
	} {
		if !validV2DefaultString(value.value, maxAcceptanceDefaultStringBytes) && value.path != "/plan_path" && value.path != "/manifest_path" {
			diagnostics.add("matrix_schema_invalid", value.path)
			valid = false
		}
	}
	if !acceptanceV2RepositoryRe.MatchString(matrix.Repository) || len([]byte(matrix.Repository)) > 256 {
		diagnostics.add("matrix_schema_invalid", "/repository")
		valid = false
	}
	if !acceptanceV2TicketRe.MatchString(matrix.TicketID) || len([]byte(matrix.TicketID)) > 32 {
		diagnostics.add("matrix_schema_invalid", "/ticket_id")
		valid = false
	}
	if !validV2Revision(matrix.TicketRevision) {
		diagnostics.add("matrix_schema_invalid", "/ticket_revision")
		valid = false
	}
	if matrix.ProfilePath != "profiles/pi-sampler.json" || matrix.PolicyPath != "profiles/pi-sampler.json" {
		diagnostics.add("binding_mismatch", "/profile_path")
		valid = false
	}
	if matrix.ManifestContractPath != "contracts/implementation-plan-manifest-v2.mjs" || matrix.ManifestValidatorPath != "scripts/validate-implementation-plan.mjs" || matrix.MatrixContractPath != "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json" {
		diagnostics.add("binding_mismatch", "/manifest_contract_path")
		valid = false
	}
	for _, value := range []struct{ value, path string }{{matrix.ProfileSHA256, "/profile_sha256"}, {matrix.PlanSHA256, "/plan_sha256"}, {matrix.ManifestSHA256, "/manifest_sha256"}, {matrix.ManifestContractSHA256, "/manifest_contract_sha256"}, {matrix.ManifestValidatorSHA256, "/manifest_validator_sha256"}, {matrix.MatrixContractSHA256, "/matrix_contract_sha256"}, {matrix.PolicySHA256, "/policy_sha256"}} {
		if !validV2Digest(value.value) {
			diagnostics.add("matrix_schema_invalid", value.path)
			valid = false
		}
	}
	if matrix.ProfileSHA256 != matrix.PolicySHA256 {
		diagnostics.add("binding_mismatch", "/policy_sha256")
		valid = false
	}
	if !validV2Revision(matrix.BaseSHA) || !validV2Revision(matrix.HeadSHA) || matrix.BaseSHA == matrix.HeadSHA {
		diagnostics.add("binding_mismatch", "/head_sha")
		valid = false
	}
	if matrix.PullRequestNumber < 1 || matrix.PullRequestNumber > 1_000_000_000 {
		diagnostics.add("matrix_schema_invalid", "/pull_request_number")
		valid = false
	}
	if !validV2PortablePath(matrix.PlanPath, 256) {
		diagnostics.add("matrix_schema_invalid", "/plan_path")
		valid = false
	}
	if !validV2PortablePath(matrix.ManifestPath, 256) {
		diagnostics.add("matrix_schema_invalid", "/manifest_path")
		valid = false
	}
	if siblingManifestPath(matrix.PlanPath) == "" || matrix.ManifestPath != siblingManifestPath(matrix.PlanPath) {
		diagnostics.add("artifact_path_mismatch", "/manifest_path")
		valid = false
	}
	if !acceptanceV2OpaqueRootRe.MatchString(matrix.EvidenceRootID) || len([]byte(matrix.EvidenceRootID)) > 128 {
		diagnostics.add("matrix_schema_invalid", "/evidence_root_id")
		valid = false
	}
	generated, generatedOK := parseV2Timestamp(matrix.GeneratedAt)
	if !generatedOK {
		diagnostics.add("matrix_schema_invalid", "/generated_at")
		valid = false
	}
	if len(matrix.Rows) < 1 || len(matrix.Rows) > maxAcceptanceV2Rows {
		diagnostics.add("matrix_schema_invalid", "/rows")
		valid = false
	}
	if facts.Format != NormalizedFactsV1Format || facts.Version != NormalizedFactsV1Version {
		diagnostics.add("binding_mismatch", "/normalized_facts")
		valid = false
	}
	return generated, valid
}

func validateAcceptanceV2FactsAgainstMatrix(matrix AcceptanceMatrixV2, facts NormalizedFactsV1, diagnostics *acceptanceV2Diagnostics) {
	checks := []struct{ actual, expected, path string }{
		{matrix.Repository, facts.Repository, "/repository"}, {matrix.TicketID, facts.TicketID, "/ticket_id"}, {matrix.TicketRevision, facts.TicketRevision, "/ticket_revision"}, {matrix.ProfilePath, facts.ProfilePath, "/profile_path"}, {matrix.ProfileSHA256, facts.ProfileSHA256, "/profile_sha256"}, {matrix.BaseSHA, facts.BaseSHA, "/base_sha"}, {matrix.HeadSHA, facts.HeadSHA, "/head_sha"}, {matrix.PlanPath, facts.PlanPath, "/plan_path"}, {matrix.PlanSHA256, facts.PlanSHA256, "/plan_sha256"}, {matrix.ManifestPath, facts.ManifestPath, "/manifest_path"}, {matrix.ManifestSHA256, facts.ManifestSHA256, "/manifest_sha256"}, {matrix.ManifestSchemaVersion, facts.ManifestSchemaVersion, "/manifest_schema_version"}, {matrix.ManifestContractSHA256, facts.ManifestContractSHA256, "/manifest_contract_sha256"}, {matrix.ManifestValidatorSHA256, facts.ManifestValidatorSHA256, "/manifest_validator_sha256"}, {matrix.MatrixContractSHA256, facts.MatrixContractSHA256, "/matrix_contract_sha256"}, {matrix.PolicySHA256, facts.PolicySHA256, "/policy_sha256"}, {matrix.EvaluationScope, facts.EvaluationScope, "/evaluation_scope"},
	}
	for _, check := range checks {
		if check.actual != check.expected {
			code := "binding_mismatch"
			if strings.HasSuffix(check.path, "sha256") {
				code = "digest_mismatch"
			}
			diagnostics.add(code, check.path)
		}
	}
	if matrix.PullRequestNumber != facts.PullRequestNumber {
		diagnostics.add("binding_mismatch", "/pull_request_number")
	}
	if len(matrix.Rows) != len(facts.Rows) {
		if len(matrix.Rows) < len(facts.Rows) {
			diagnostics.add("row_missing", "/rows")
		} else {
			diagnostics.add("row_unknown", "/rows")
		}
	}
}

func validateAcceptanceV2Rows(matrix AcceptanceMatrixV2, facts NormalizedFactsV1, diagnostics *acceptanceV2Diagnostics) {
	if len(matrix.Rows) > maxAcceptanceV2Rows {
		return
	}
	factByID := make(map[string]NormalizedFactsV1Row, len(facts.Rows))
	for _, row := range facts.Rows {
		factByID[row.ID] = row
	}
	seen := make(map[string]bool)
	for index, row := range matrix.Rows {
		path := fmt.Sprintf("/rows/%d", index)
		if seen[row.ID] {
			diagnostics.add("row_duplicate", path+"/id")
		} else {
			seen[row.ID] = true
		}
		expected, exists := factByID[row.ID]
		if !exists {
			diagnostics.add("row_unknown", path+"/id")
		} else if row.AcceptanceClass != expected.AcceptanceClass || row.Requirement != expected.Requirement {
			diagnostics.add("row_binding_mismatch", path)
		}
		if !validV2Identifier(row.ID) || !validV2DefaultString(row.Requirement, maxAcceptanceDefaultStringBytes) || !validV2DefaultString(row.AcceptanceClass, 64) {
			diagnostics.add("matrix_schema_invalid", path)
		}
	}
	for index, expected := range facts.Rows {
		if index >= len(matrix.Rows) {
			diagnostics.add("row_missing", fmt.Sprintf("/rows/%d", index))
			continue
		}
		if matrix.Rows[index].ID != expected.ID {
			diagnostics.add("row_reordered", fmt.Sprintf("/rows/%d/id", index))
		}
	}
	if len(matrix.Rows) == len(facts.Rows) {
		allSameSet := true
		for _, expected := range facts.Rows {
			if !seen[expected.ID] {
				allSameSet = false
				break
			}
		}
		if allSameSet {
			for i, expected := range facts.Rows {
				if matrix.Rows[i].ID != expected.ID {
					diagnostics.add("row_reordered", "/rows")
					break
				}
			}
		}
	}
	for index, row := range matrix.Rows {
		validateAcceptanceV2RowShape(row, matrix.EvaluationScope, fmt.Sprintf("/rows/%d", index), diagnostics)
	}
}

func validateAcceptanceV2RowShape(row AcceptanceMatrixV2Row, scope, path string, diagnostics *acceptanceV2Diagnostics) {
	classes := map[string]bool{"ordinary": true, "authority": true, "requirement": true, "resource-bounded": true, "concurrency": true, "evidence": true, "benchmark": true}
	if !classes[row.AcceptanceClass] {
		diagnostics.add("matrix_schema_invalid", path+"/acceptance_class")
	}
	if !validV2DefaultString(row.ID, 128) || !validV2Identifier(row.ID) {
		diagnostics.add("matrix_schema_invalid", path+"/id")
	}
	if !validV2DefaultString(row.Requirement, maxAcceptanceDefaultStringBytes) {
		diagnostics.add("matrix_schema_invalid", path+"/requirement")
	}
	if scope == "plan-publication" {
		if row.Status != "specified" || row.Specification == nil || row.Evidence != nil || row.Blocker != nil {
			diagnostics.add("scope_status_mismatch", path+"/status")
		}
		if row.Specification != nil {
			validateAcceptanceV2EvidenceShape(*row.Specification, path+"/specification", diagnostics)
		}
		return
	}
	if scope != "implementation-delivery" {
		return
	}
	switch row.Status {
	case "observed":
		if row.Evidence == nil || row.Specification != nil || row.Blocker != nil {
			diagnostics.add("scope_status_mismatch", path+"/status")
		} else {
			validateAcceptanceV2EvidenceShape(*row.Evidence, path+"/evidence", diagnostics)
		}
	case "blocked":
		if row.Blocker == nil || row.Evidence != nil || row.Specification != nil {
			diagnostics.add("scope_status_mismatch", path+"/status")
		} else {
			validateAcceptanceV2BlockerShape(*row.Blocker, path+"/blocker", diagnostics)
		}
	default:
		diagnostics.add("scope_status_mismatch", path+"/status")
	}
}

func validateAcceptanceV2EvidenceShape(evidence AcceptanceEvidenceV2, path string, diagnostics *acceptanceV2Diagnostics) {
	if !validV2ASCII(evidence.Verifier.ID, 128) || !validV2ASCII(evidence.Verifier.Version, 128) {
		diagnostics.add("matrix_schema_invalid", path+"/verifier")
	}
	if evidence.Verifier.Environment != "local" && evidence.Verifier.Environment != "ci" && evidence.Verifier.Environment != "review" && evidence.Verifier.Environment != "external" {
		diagnostics.add("matrix_schema_invalid", path+"/verifier/environment")
	}
	if len(evidence.Verifier.Argv) < 1 || len(evidence.Verifier.Argv) > maxAcceptanceV2Argv {
		diagnostics.add("matrix_schema_invalid", path+"/verifier/argv")
	}
	for index, arg := range evidence.Verifier.Argv {
		if !validV2DefaultString(arg, 256) {
			diagnostics.add("matrix_schema_invalid", fmt.Sprintf("%s/verifier/argv/%d", path, index))
		}
	}
	if evidence.ExitStatus != 0 {
		diagnostics.add("matrix_schema_invalid", path+"/exit_status")
	}
	started, startOK := parseV2Timestamp(evidence.StartedAt)
	completed, completeOK := parseV2Timestamp(evidence.CompletedAt)
	if !startOK {
		diagnostics.add("matrix_schema_invalid", path+"/started_at")
	}
	if !completeOK {
		diagnostics.add("matrix_schema_invalid", path+"/completed_at")
	}
	if startOK && completeOK && (completed.Before(started) || completed.Sub(started) > maxAcceptanceV2Duration) {
		diagnostics.add("matrix_schema_invalid", path+"/completed_at")
	}
	if len(evidence.Artifacts) < 1 || len(evidence.Artifacts) > maxAcceptanceV2Artifacts {
		diagnostics.add("matrix_schema_invalid", path+"/artifacts")
	}
	seenNames, seenPaths := map[string]bool{}, map[string]bool{}
	aggregate := int64(0)
	for index, artifact := range evidence.Artifacts {
		artifactPath := fmt.Sprintf("%s/artifacts/%d", path, index)
		if !validV2ArtifactName(artifact.Name) {
			diagnostics.add("matrix_schema_invalid", artifactPath+"/name")
		}
		if !validV2ArtifactPath(artifact.Path) {
			diagnostics.add("evidence_path_invalid", artifactPath+"/path")
		}
		pathKey := externalIdentityKey(artifact.Path)
		nameKey := externalIdentityKey(artifact.Name)
		if seenNames[nameKey] || seenPaths[pathKey] {
			diagnostics.add("matrix_schema_invalid", artifactPath)
		}
		seenNames[nameKey] = true
		seenPaths[pathKey] = true
		if !validV2Digest(artifact.SHA256) || artifact.Bytes < 0 {
			diagnostics.add("matrix_schema_invalid", artifactPath)
		} else if artifact.Bytes > maxAcceptanceV2ArtifactBytes {
			diagnostics.add("artifact_too_large", artifactPath+"/bytes")
		}
		aggregate += artifact.Bytes
		if aggregate > maxAcceptanceV2EvidenceBytes {
			diagnostics.add("artifact_too_large", path+"/artifacts")
		}
	}
}

func validateAcceptanceV2BlockerShape(blocker AcceptanceBlockerV2, path string, diagnostics *acceptanceV2Diagnostics) {
	if !acceptanceV2BlockerCodeRe.MatchString(blocker.Code) || len([]byte(blocker.Code)) > 64 {
		diagnostics.add("matrix_schema_invalid", path+"/code")
	}
	if !validV2DefaultString(blocker.Reason, maxAcceptanceDefaultStringBytes) {
		diagnostics.add("matrix_schema_invalid", path+"/reason")
	}
	if blocker.BlockedBy != nil && !validV2Identifier(*blocker.BlockedBy) {
		diagnostics.add("matrix_schema_invalid", path+"/blocked_by")
	}
}

func acceptanceV2Policy(data json.RawMessage) (AcceptancePolicyV2, bool) {
	if len(data) == 0 || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return AcceptancePolicyV2{}, false
	}
	var policy AcceptancePolicyV2
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&policy); err != nil || len(policy.Classes) == 0 || len(policy.Classes) > 32 {
		return AcceptancePolicyV2{}, false
	}
	return policy, true
}

func acceptanceV2ClassFor(policy AcceptancePolicyV2, acceptanceClass string) ([]AcceptanceClassPolicyV2, bool) {
	matches := make([]AcceptanceClassPolicyV2, 0, 2)
	for _, class := range policy.Classes {
		if acceptanceClass == "evidence" && class.Kind == "evidence" {
			matches = append(matches, class)
			continue
		}
		if acceptanceClass == "benchmark" && class.Kind == "benchmark" {
			matches = append(matches, class)
			continue
		}
		if class.ID == acceptanceClass {
			matches = append(matches, class)
		}
	}
	return matches, len(matches) > 0
}

func equalStringSlice(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func validateAcceptanceV2EvidenceTimes(matrix AcceptanceMatrixV2, generated time.Time, diagnostics *acceptanceV2Diagnostics) {
	if generated.IsZero() {
		return
	}
	for index, row := range matrix.Rows {
		var evidence *AcceptanceEvidenceV2
		field := "evidence"
		if matrix.EvaluationScope == "plan-publication" {
			evidence = row.Specification
			field = "specification"
		} else if row.Status == "observed" {
			evidence = row.Evidence
		}
		if evidence == nil {
			continue
		}
		started, startedOK := parseV2Timestamp(evidence.StartedAt)
		completed, completedOK := parseV2Timestamp(evidence.CompletedAt)
		if startedOK && completedOK && (started.After(generated) || completed.After(generated)) {
			diagnostics.add("matrix_schema_invalid", fmt.Sprintf("/rows/%d/%s/completed_at", index, field))
		}
	}
}

func validateAcceptanceV2PolicyAndArtifacts(matrix AcceptanceMatrixV2, policy AcceptancePolicyV2, policyOK bool, root *ExternalEvidenceRoot, diagnostics *acceptanceV2Diagnostics) {
	for index, row := range matrix.Rows {
		path := fmt.Sprintf("/rows/%d", index)
		if matrix.EvaluationScope == "plan-publication" {
			if row.Specification == nil {
				continue
			}
			validateAcceptanceV2Artifacts(root, *row.Specification, path+"/specification", true, diagnostics)
			continue
		}
		if row.Status == "blocked" {
			continue
		}
		if row.Evidence == nil {
			continue
		}
		validateAcceptanceV2Artifacts(root, *row.Evidence, path+"/evidence", false, diagnostics)
		if row.AcceptanceClass == "evidence" || row.AcceptanceClass == "benchmark" {
			// Slice 1 permits these classes in a specification, but has no
			// separately trusted implementation verifier/threshold policy.
			diagnostics.add("unsupported_class_policy", path+"/acceptance_class")
			continue
		}
		if !policyOK {
			diagnostics.add("policy_missing", path+"/evidence/verifier")
			continue
		}
		matches, found := acceptanceV2ClassFor(policy, row.AcceptanceClass)
		if !found {
			diagnostics.add("policy_missing", path+"/acceptance_class")
			continue
		}
		if len(matches) != 1 {
			diagnostics.add("policy_ambiguous", path+"/acceptance_class")
			continue
		}
		class := matches[0]
		nonInventoryArtifacts := 0
		for _, artifact := range row.Evidence.Artifacts {
			if artifact.Name != acceptanceV2InventoryReportName {
				nonInventoryArtifacts++
			}
		}
		if nonInventoryArtifacts == 0 {
			diagnostics.add("verifier_policy_mismatch", path+"/evidence/artifacts")
			continue
		}
		if row.AcceptanceClass == "requirement" {
			requirementArtifacts := 0
			for _, artifact := range row.Evidence.Artifacts {
				if artifact.Name != acceptanceV2InventoryReportName {
					requirementArtifacts++
				}
			}
			if requirementArtifacts != 1 {
				diagnostics.add("verifier_policy_mismatch", path+"/evidence/artifacts")
				continue
			}
		}
		verifier := row.Evidence.Verifier
		expectedEnvironment, expectedArgv := class.Environment, class.Command
		if row.AcceptanceClass == "requirement" {
			expectedEnvironment, expectedArgv = "external", []string{"external:wiki-requirement"}
		}
		if class.ID != row.AcceptanceClass || (row.AcceptanceClass == "requirement" && class.Kind != "requirement") || verifier.ID != class.Verifier || verifier.Environment != expectedEnvironment || !equalStringSlice(verifier.Argv, expectedArgv) || (class.Version != "" && verifier.Version != class.Version) {
			diagnostics.add("verifier_policy_mismatch", path+"/evidence/verifier")
		}
	}
}

func addAcceptanceV2ExternalError(diagnostics *acceptanceV2Diagnostics, err error, path string) {
	if externalError, ok := err.(*ExternalEvidenceError); ok {
		switch externalError.Code {
		case "artifact_too_large", "evidence_path_invalid", "evidence_identity_changed", "artifact_digest_mismatch":
			diagnostics.add(externalError.Code, path)
			return
		}
	}
	diagnostics.add("evidence_root_invalid", path)
}

func validatePlanValidatorReport(data []byte) bool {
	if len(data) == 0 || len(data) > maxAcceptanceV2ArtifactBytes || scanAcceptanceV2JSON(data) != nil {
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || len(object) != 2 {
		return false
	}
	if _, ok := object["ok"]; !ok {
		return false
	}
	if _, ok := object["exit_status"]; !ok {
		return false
	}
	var okValue bool
	var exitStatus int
	if json.Unmarshal(object["ok"], &okValue) != nil || json.Unmarshal(object["exit_status"], &exitStatus) != nil {
		return false
	}
	return okValue && exitStatus == 0
}

func validateIndependentPlanReview(data []byte) bool {
	if len(data) == 0 || len(data) > maxAcceptanceV2ArtifactBytes || !utf8.Valid(data) || bytes.Contains(data, []byte{0}) {
		return false
	}
	text := string(data)
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	anchored := 0
	inFence := false
	for _, line := range lines {
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
			inFence = !inFence
			continue
		}
		if strings.HasPrefix(line, "decision:") {
			if inFence {
				return false
			}
			anchored++
			if line != "decision: approved" {
				return false
			}
		}
	}
	if anchored != 1 || strings.Count(strings.ToLower(text), "decision:") != 1 {
		return false
	}
	lower := strings.ToLower(text)
	for _, marker := range []string{"unapproved", "disapproved", "conditional", "provisional", "subject to", "pending approval", "pending decision"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}

func validateAcceptanceV2Artifacts(root *ExternalEvidenceRoot, evidence AcceptanceEvidenceV2, path string, publication bool, diagnostics *acceptanceV2Diagnostics) {
	if root == nil {
		diagnostics.add("evidence_root_invalid", "/evidence_root")
		return
	}
	var validatorArtifact, reviewArtifact *AcceptanceArtifactV2
	verified := make(map[string][]byte, len(evidence.Artifacts))
	for index, artifact := range evidence.Artifacts {
		artifactPath := fmt.Sprintf("%s/artifacts/%d", path, index)
		data, err := ReadVerifiedArtifact(root, artifact)
		if err != nil {
			code := "evidence_identity_changed"
			if externalEvidenceError, ok := err.(*ExternalEvidenceError); ok && externalEvidenceError.Code != "" {
				code = externalEvidenceError.Code
			}
			if code == "artifact_too_large" {
				diagnostics.add(code, artifactPath)
			} else if code == "evidence_path_invalid" {
				diagnostics.add(code, artifactPath+"/path")
			} else if code == "artifact_digest_mismatch" {
				diagnostics.add(code, artifactPath+"/sha256")
			} else {
				diagnostics.add("evidence_identity_changed", artifactPath)
			}
			continue
		}
		verified[artifact.Path] = data
		if artifact.Name == "plan-validator-report.json" {
			copy := artifact
			validatorArtifact = &copy
		}
		if artifact.Name == "independent-plan-review.md" {
			copy := artifact
			reviewArtifact = &copy
		}
		_ = data
	}
	if publication {
		if validatorArtifact == nil || reviewArtifact == nil {
			diagnostics.add("artifact_path_mismatch", path+"/artifacts")
		}
		if validatorArtifact != nil {
			data, present := verified[validatorArtifact.Path]
			if !present || !validatePlanValidatorReport(data) {
				diagnostics.add("matrix_schema_invalid", path+"/artifacts/plan-validator-report.json")
			}
		}
		if reviewArtifact != nil {
			data, present := verified[reviewArtifact.Path]
			if !present || !validateIndependentPlanReview(data) {
				diagnostics.add("matrix_schema_invalid", path+"/artifacts/independent-plan-review.md")
			}
		}
	}
}

const AcceptanceV2InventoryReportName = "evidence-inventory.json"
const acceptanceV2InventoryReportName = AcceptanceV2InventoryReportName

// CanonicalExternalEvidenceInventoryReport returns the strict report bytes
// retained as the one self-excluded inventory artifact. Entries are sorted by
// their raw portable path; the report itself is never an entry.
func CanonicalExternalEvidenceInventoryReport(inventory ExternalEvidenceInventory) []byte {
	entries := make([]ExternalEvidenceInventoryEntry, 0, len(inventory.Entries))
	for _, entry := range inventory.Entries {
		if entry.Path != acceptanceV2InventoryReportName {
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	appendJSONStringField(&buffer, &first, "format", ExternalEvidenceInventoryFormat)
	appendJSONIntNativeField(&buffer, &first, "version", ExternalEvidenceInventoryVersion)
	items := make([][]byte, len(entries))
	for index, entry := range entries {
		var item bytes.Buffer
		item.WriteByte('{')
		itemFirst := true
		appendJSONStringField(&item, &itemFirst, "path", entry.Path)
		appendJSONStringField(&item, &itemFirst, "type", entry.Type)
		appendJSONIntField(&item, &itemFirst, "bytes", entry.Bytes)
		appendJSONStringField(&item, &itemFirst, "identity", entry.Identity)
		appendJSONStringField(&item, &itemFirst, "sha256", entry.SHA256)
		item.WriteByte('}')
		items[index] = item.Bytes()
	}
	var list bytes.Buffer
	list.WriteByte('[')
	for index, item := range items {
		if index > 0 {
			list.WriteByte(',')
		}
		list.Write(item)
	}
	list.WriteByte(']')
	appendJSONField(&buffer, &first, "entries", list.Bytes())
	buffer.WriteByte('}')
	buffer.WriteByte('\n')
	return buffer.Bytes()
}

func parseExternalEvidenceInventoryReport(data []byte) (ExternalEvidenceInventory, bool) {
	if len(data) == 0 || len(data) > maxAcceptanceV2InventoryReportBytes || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) || scanAcceptanceV2JSON(data) != nil {
		return ExternalEvidenceInventory{}, false
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil || len(root) != 3 || !requiredJSONMembers(root, "format", "version", "entries") {
		return ExternalEvidenceInventory{}, false
	}
	var format string
	var version int
	if json.Unmarshal(root["format"], &format) != nil || json.Unmarshal(root["version"], &version) != nil || format != ExternalEvidenceInventoryFormat || version != ExternalEvidenceInventoryVersion {
		return ExternalEvidenceInventory{}, false
	}
	var rawEntries []map[string]json.RawMessage
	if json.Unmarshal(root["entries"], &rawEntries) != nil || len(rawEntries) > externalRootMaxEntries {
		return ExternalEvidenceInventory{}, false
	}
	inventory := ExternalEvidenceInventory{Entries: make([]ExternalEvidenceInventoryEntry, len(rawEntries))}
	for index, raw := range rawEntries {
		if len(raw) != 5 || !requiredJSONMembers(raw, "path", "type", "bytes", "identity", "sha256") {
			return ExternalEvidenceInventory{}, false
		}
		var entry ExternalEvidenceInventoryEntry
		entryBytes, err := json.Marshal(raw)
		if err != nil || json.Unmarshal(entryBytes, &entry) != nil || !validV2ArtifactPath(entry.Path) || (entry.Type != "file" && entry.Type != "directory") || entry.Bytes < 0 || entry.Bytes > maxAcceptanceV2ArtifactBytes || !validV2DefaultString(entry.Identity, maxAcceptanceV2InventoryReportBytes) || !validV2Digest(entry.SHA256) {
			return ExternalEvidenceInventory{}, false
		}
		if entry.Type == "directory" && (entry.Bytes != 0 || entry.SHA256 != DigestOutput(nil)) {
			return ExternalEvidenceInventory{}, false
		}
		if entry.Type == "file" && entry.Bytes < 0 {
			return ExternalEvidenceInventory{}, false
		}
		if index > 0 && inventory.Entries[index-1].Path >= entry.Path {
			return ExternalEvidenceInventory{}, false
		}
		inventory.Entries[index] = entry
	}
	if !bytes.Equal(data, CanonicalExternalEvidenceInventoryReport(inventory)) {
		return ExternalEvidenceInventory{}, false
	}
	return inventory, true
}

func validateAcceptanceV2InventoryReport(root *ExternalEvidenceRoot, matrix AcceptanceMatrixV2, inventory ExternalEvidenceInventory, diagnostics *acceptanceV2Diagnostics) {
	if root == nil {
		return
	}
	seen := false
	for index, row := range matrix.Rows {
		var evidence *AcceptanceEvidenceV2
		field := "evidence"
		if matrix.EvaluationScope == "plan-publication" {
			evidence, field = row.Specification, "specification"
		} else if row.Status == "observed" {
			evidence = row.Evidence
		}
		if evidence == nil {
			continue
		}
		for artifactIndex, artifact := range evidence.Artifacts {
			if artifact.Name != acceptanceV2InventoryReportName {
				continue
			}
			seen = true
			data, err := ReadVerifiedArtifact(root, artifact)
			if err != nil {
				continue
			}
			reported, ok := parseExternalEvidenceInventoryReport(data)
			if !ok || !externalInventoryEqual(reported, inventory) {
				diagnostics.add("matrix_schema_invalid", fmt.Sprintf("/rows/%d/%s/artifacts/%d", index, field, artifactIndex))
			}
		}
	}
	if !seen {
		for _, row := range matrix.Rows {
			if (matrix.EvaluationScope == "plan-publication" && row.Specification != nil) || (matrix.EvaluationScope == "implementation-delivery" && row.Status == "observed" && row.Evidence != nil) {
				diagnostics.add("artifact_path_mismatch", "/evidence_root/inventory")
				break
			}
		}
	}
}

func validateAcceptanceV2ClosedWorld(matrix AcceptanceMatrixV2, inventory ExternalEvidenceInventory, diagnostics *acceptanceV2Diagnostics) {
	// A shared immutable artifact may be referenced by every publication row.
	// Count unique path/name bindings, not row references, while rejecting any
	// conflicting reuse under either identity. Directory inventory entries are
	// admissible only when they are exact ancestors required by a referenced
	// regular artifact; this keeps nested evidence closed-world without making
	// a relative path such as dir/proof.txt impossible to realize.
	referenced := make(map[string]AcceptanceArtifactV2)
	referencedNames := make(map[string]string)
	requiredDirectories := make(map[string]string)
	reportPaths := make(map[string]struct{})
	for _, row := range matrix.Rows {
		var evidence *AcceptanceEvidenceV2
		if matrix.EvaluationScope == "plan-publication" {
			evidence = row.Specification
		} else if row.Status == "observed" {
			evidence = row.Evidence
		}
		if evidence == nil {
			continue
		}
		for _, artifact := range evidence.Artifacts {
			pathKey := externalIdentityKey(artifact.Path)
			nameKey := externalIdentityKey(artifact.Name)
			if artifact.Name == acceptanceV2InventoryReportName {
				if artifact.Path == acceptanceV2InventoryReportName {
					reportPaths[pathKey] = struct{}{}
				} else {
					diagnostics.add("artifact_path_mismatch", "/evidence_root/inventory")
				}
				continue
			}
			if prior, exists := referenced[pathKey]; exists && (prior.Name != artifact.Name || prior.SHA256 != artifact.SHA256 || prior.Bytes != artifact.Bytes) {
				diagnostics.add("artifact_path_mismatch", "/evidence_root")
			}
			if priorPath, exists := referencedNames[nameKey]; exists && priorPath != pathKey {
				diagnostics.add("artifact_path_mismatch", "/evidence_root")
			}
			referenced[pathKey] = artifact
			referencedNames[nameKey] = pathKey
			parts := strings.Split(artifact.Path, "/")
			for index := 1; index < len(parts); index++ {
				ancestor := strings.Join(parts[:index], "/")
				ancestorKey := externalIdentityKey(ancestor)
				if prior, exists := requiredDirectories[ancestorKey]; exists && prior != ancestor {
					diagnostics.add("artifact_path_mismatch", "/evidence_root")
				} else {
					requiredDirectories[ancestorKey] = ancestor
				}
			}
		}
	}
	if len(referenced) == 0 && len(reportPaths) == 0 {
		if len(inventory.Entries) != 0 {
			diagnostics.add("artifact_path_mismatch", "/evidence_root")
		}
		return
	}
	if len(reportPaths) != 1 {
		diagnostics.add("artifact_path_mismatch", "/evidence_root/inventory")
	}
	actualFiles := make(map[string]ExternalEvidenceInventoryEntry)
	actualDirectories := make(map[string]ExternalEvidenceInventoryEntry)
	for _, entry := range inventory.Entries {
		key := externalIdentityKey(entry.Path)
		switch entry.Type {
		case "file":
			if _, exists := actualFiles[key]; exists {
				diagnostics.add("artifact_path_mismatch", "/evidence_root")
			}
			actualFiles[key] = entry
		case "directory":
			expected, required := requiredDirectories[key]
			if !required || expected != entry.Path {
				diagnostics.add("artifact_path_mismatch", "/evidence_root/"+entry.Path)
			}
			if _, exists := actualDirectories[key]; exists {
				diagnostics.add("artifact_path_mismatch", "/evidence_root")
			}
			actualDirectories[key] = entry
		default:
			diagnostics.add("artifact_path_mismatch", "/evidence_root/"+entry.Path)
		}
	}
	if len(actualFiles) != len(referenced) || len(actualDirectories) != len(requiredDirectories) {
		diagnostics.add("artifact_path_mismatch", "/evidence_root")
	}
	for pathKey, artifact := range referenced {
		entry, exists := actualFiles[pathKey]
		if !exists || entry.Path != artifact.Path || entry.Bytes != artifact.Bytes || entry.SHA256 != artifact.SHA256 {
			diagnostics.add("artifact_path_mismatch", "/evidence_root")
		}
	}
	for pathKey := range actualFiles {
		if _, exists := referenced[pathKey]; !exists {
			diagnostics.add("artifact_path_mismatch", "/evidence_root")
		}
	}
	for pathKey := range actualDirectories {
		if _, exists := requiredDirectories[pathKey]; !exists {
			diagnostics.add("artifact_path_mismatch", "/evidence_root")
		}
	}
}

func acceptanceV2InitialResult(request AcceptanceV2Request, matrixSHA string) AcceptanceResultV1 {
	factsDigest := request.FactsSHA256
	if !validV2Digest(factsDigest) {
		factsDigest = strings.Repeat("0", 64)
	}
	return AcceptanceResultV1{Format: AcceptanceResultV1Format, Version: AcceptanceResultV1Version, Status: "invalid", Code: "usage_invalid", EvaluationScope: request.NormalizedFacts.EvaluationScope, FactsSHA256: factsDigest, MatrixSHA256: matrixSHA, Rows: []AcceptanceResultV1Row{}, Diagnostics: []AcceptanceDiagnosticV1{}}
}

func acceptanceV2RequestFromInput(input any) (AcceptanceV2Request, bool) {
	var request AcceptanceV2Request
	switch value := input.(type) {
	case AcceptanceV2Request:
		return value, true
	case *AcceptanceV2Request:
		if value == nil {
			return request, false
		}
		return *value, true
	case []byte:
		parsed, err := DecodeAcceptanceV2Request(value)
		if err != nil {
			return request, false
		}
		return parsed, true
	default:
		return request, false
	}
}

func ValidateAcceptanceV2(input any) AcceptanceResultV1 {
	return ValidateAcceptanceV2WithExclusions(input, nil)
}

func ValidateAcceptanceV2WithExclusions(input any, exclusions []string) AcceptanceResultV1 {
	request, ok := acceptanceV2RequestFromInput(input)
	if !ok {
		return acceptanceV2InitialResult(request, strings.Repeat("0", 64))
	}
	return validateAcceptanceV2RequestWithExclusions(request, exclusions)
}

func schemaVersionFromBytes(data []byte, member string) (string, bool) {
	if len(data) == 0 || len(data) > maxAcceptanceJSONBytes || scanJSONValueForVersion(data) != nil {
		return "", false
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil {
		return "", false
	}
	var version string
	raw, ok := root[member]
	if !ok || json.Unmarshal(raw, &version) != nil || version == "" {
		return "", false
	}
	return version, true
}

// scanJSONValueForVersion applies the frozen bounded scanner without imposing
// the v2 matrix-specific size limit. It keeps pair classification fail-closed
// while allowing a historical v1 bundle to reach its own validator unchanged.
func scanJSONValueForVersion(data []byte) error {
	if len(data) == 0 || len(data) > maxAcceptanceJSONBytes || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return errV2JSONInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	budget := &jsonBudget{}
	if err := scanJSONValue(decoder, 0, budget); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errV2TrailingValue
	}
	return nil
}

// ClassifyAcceptanceVersionPair is the public boundary classifier. Exact
// v1/v1 is a legacy pair, exact v2/v2 is the additive path, mixed pairs are
// never projected between versions, and all unknown/alias/future pairs fail
// closed. It performs no v1-to-v2 conversion.
func ClassifyAcceptanceVersionPair(matrixBytes, manifestBytes []byte) string {
	matrixVersion, matrixOK := schemaVersionFromBytes(matrixBytes, "schema_version")
	manifestVersion, manifestOK := schemaVersionFromBytes(manifestBytes, "schema_version")
	if matrixOK && manifestOK && matrixVersion == AcceptanceMatrixSchemaVersion && manifestVersion == AcceptanceManifestSchemaVersion {
		return "v1/v1"
	}
	if matrixOK && manifestOK && matrixVersion == AcceptanceMatrixV2SchemaVersion && manifestVersion == AcceptanceManifestV2SchemaVersion {
		return "v2/v2"
	}
	matrixKnown := matrixVersion == AcceptanceMatrixSchemaVersion || matrixVersion == AcceptanceMatrixV2SchemaVersion
	manifestKnown := manifestVersion == AcceptanceManifestSchemaVersion || manifestVersion == AcceptanceManifestV2SchemaVersion
	if matrixOK && manifestOK && matrixKnown && manifestKnown && matrixVersion != manifestVersion {
		return "version_pair_mixed"
	}
	return "version_pair_unsupported"
}

// ClassifyAcceptanceVersionPairFiles is used by the public legacy CLI boundary
// before it invokes the unchanged v1 bundle API.
func ClassifyAcceptanceVersionPairFiles(matrixPath, manifestPath string) (string, error) {
	matrixBytes, err := boundedRead(matrixPath, "acceptance matrix", maxAcceptanceJSONBytes)
	if err != nil {
		return "version_pair_unsupported", err
	}
	manifestBytes, err := boundedRead(manifestPath, "acceptance manifest", maxAcceptanceJSONBytes)
	if err != nil {
		return "version_pair_unsupported", err
	}
	return ClassifyAcceptanceVersionPair(matrixBytes, manifestBytes), nil
}

func acceptanceV2VersionPairCode(matrixBytes []byte, facts NormalizedFactsV1) string {
	var root map[string]json.RawMessage
	if json.Unmarshal(matrixBytes, &root) != nil {
		return "version_pair_unsupported"
	}
	var matrixVersion, manifestVersion string
	if raw, ok := root["schema_version"]; ok {
		_ = json.Unmarshal(raw, &matrixVersion)
	}
	if raw, ok := root["manifest_schema_version"]; ok {
		_ = json.Unmarshal(raw, &manifestVersion)
	}
	pair := ClassifyAcceptanceVersionPair(matrixBytes, []byte(fmt.Sprintf(`{"schema_version":%q}`, manifestVersion)))
	factsV1 := facts.ManifestSchemaVersion == AcceptanceManifestSchemaVersion
	factsV2 := facts.ManifestSchemaVersion == AcceptanceManifestV2SchemaVersion
	if pair == "v1/v1" && factsV1 {
		// This stdin contract has no manifest bytes or legacy result channel;
		// keep the pair outside v2 rather than projecting it into a v2 success.
		return "version_pair_unsupported"
	}
	if pair == "v2/v2" && factsV2 {
		return ""
	}
	matrixV1 := matrixVersion == AcceptanceMatrixSchemaVersion
	matrixV2 := matrixVersion == AcceptanceMatrixV2SchemaVersion
	manifestV1 := manifestVersion == AcceptanceManifestSchemaVersion
	manifestV2 := manifestVersion == AcceptanceManifestV2SchemaVersion
	if (matrixV1 && manifestV2) || (matrixV2 && manifestV1) || (matrixV2 && manifestV2 && factsV1) || (matrixV1 && manifestV1 && factsV2) {
		return "version_pair_mixed"
	}
	return "version_pair_unsupported"
}

func validateAcceptanceV2Request(request AcceptanceV2Request) AcceptanceResultV1 {
	return validateAcceptanceV2RequestWithExclusions(request, nil)
}

func validateAcceptanceV2RequestWithExclusions(request AcceptanceV2Request, exclusions []string) AcceptanceResultV1 {
	matrixBytes, matrixErr := base64.StdEncoding.DecodeString(request.MatrixBase64)
	matrixSHABytes := sha256.Sum256(matrixBytes)
	matrixSHA := hex.EncodeToString(matrixSHABytes[:])
	result := acceptanceV2InitialResult(request, matrixSHA)
	diagnostics := newAcceptanceV2Diagnostics()
	if request.Format != AcceptanceV2RequestFormat || request.Version != AcceptanceV2RequestVersion || request.ControllerTime == "" || request.EvidenceRoot == "" || !validV2Digest(request.FactsSHA256) {
		diagnostics.add("usage_invalid", "/request")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, nil)
	}
	if !validV2Digest(normalizedFactsDigestV1(request.NormalizedFacts)) || request.FactsSHA256 != normalizedFactsDigestV1(request.NormalizedFacts) {
		diagnostics.add("digest_mismatch", "/facts_sha256")
	}
	validateNormalizedFactsV1Shape(request.NormalizedFacts, diagnostics)
	if len(matrixBytes) > maxAcceptanceMatrixV2Bytes {
		diagnostics.add("artifact_too_large", "/matrix_base64")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, nil)
	}
	if matrixErr != nil {
		diagnostics.add(matrixErrCode(matrixErr), "/matrix_base64")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, nil)
	}
	if scanErr := scanAcceptanceV2JSON(matrixBytes); scanErr != nil {
		diagnostics.add(matrixErrCode(scanErr), "/matrix")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, nil)
	}
	if pairCode := acceptanceV2VersionPairCode(matrixBytes, request.NormalizedFacts); pairCode != "" {
		diagnostics.add(pairCode, "/version_pair")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, nil)
	}
	matrix, code := decodeAcceptanceMatrixV2(matrixBytes)
	if code != "" {
		diagnostics.add(code, "/matrix")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, nil)
	}
	generated, rootOK := validateAcceptanceV2Root(matrix, request.NormalizedFacts, diagnostics)
	if matrix.EvaluationScope != request.NormalizedFacts.EvaluationScope {
		diagnostics.add("binding_mismatch", "/evaluation_scope")
	}
	validateAcceptanceV2FactsAgainstMatrix(matrix, request.NormalizedFacts, diagnostics)
	validateAcceptanceV2Rows(matrix, request.NormalizedFacts, diagnostics)
	validateAcceptanceV2EvidenceTimes(matrix, generated, diagnostics)
	controllerTime, timeOK := parseV2Timestamp(request.ControllerTime)
	if !timeOK {
		diagnostics.add("usage_invalid", "/controller_time")
	} else if generated.After(controllerTime.Add(maxAcceptanceV2FutureSkew)) {
		diagnostics.add("matrix_schema_invalid", "/generated_at")
	}
	first := diagnostics.firstCode()
	if !rootOK || first == "matrix_schema_invalid" || first == "manifest_version_unsupported" || (first != "valid" && acceptanceV2Precedence[first] < acceptanceV2Precedence["evidence_root_invalid"]) {
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, &matrix)
	}
	root, err := OpenExternalEvidenceRoot(request.EvidenceRoot, exclusions)
	if err != nil {
		diagnostics.add("evidence_root_invalid", "/evidence_root")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, &matrix)
	}
	inventoryBefore, inventoryErr := InventoryExternalEvidenceRoot(root)
	if inventoryErr != nil {
		addAcceptanceV2ExternalError(diagnostics, inventoryErr, "/evidence_root")
		return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, &matrix)
	}
	policy, policyOK := acceptanceV2Policy(request.Policy)
	validateAcceptanceV2PolicyAndArtifacts(matrix, policy, policyOK, root, diagnostics)
	validateAcceptanceV2InventoryReport(root, matrix, inventoryBefore, diagnostics)
	if !diagnostics.has("artifact_digest_mismatch") && !diagnostics.has("evidence_identity_changed") && !diagnostics.has("evidence_path_invalid") && !diagnostics.has("unsupported_class_policy") {
		validateAcceptanceV2ClosedWorld(matrix, inventoryBefore, diagnostics)
	}
	artifactTotal := int64(0)
	for _, row := range matrix.Rows {
		var evidence *AcceptanceEvidenceV2
		if matrix.EvaluationScope == "plan-publication" {
			evidence = row.Specification
		} else if row.Status == "observed" {
			evidence = row.Evidence
		}
		if evidence != nil {
			for _, artifact := range evidence.Artifacts {
				artifactTotal += artifact.Bytes
			}
		}
	}
	if artifactTotal > maxAcceptanceV2MatrixBytes {
		diagnostics.add("artifact_too_large", "/rows")
	}
	inventoryAfter, inventoryErr := InventoryExternalEvidenceRoot(root)
	if inventoryErr != nil {
		addAcceptanceV2ExternalError(diagnostics, inventoryErr, "/evidence_root")
	} else if !externalInventoryEqual(inventoryBefore, inventoryAfter) {
		diagnostics.add("source_mutated", "/evidence_root")
	}
	if matrix.EvaluationScope == "implementation-delivery" {
		for index, row := range matrix.Rows {
			if row.Status == "blocked" {
				result.Rows = append(result.Rows, AcceptanceResultV1Row{ID: row.ID, Status: "blocked", Code: "blocked"})
			} else {
				result.Rows = append(result.Rows, AcceptanceResultV1Row{ID: row.ID, Status: "valid", Code: "observed"})
			}
			_ = index
		}
		if len(result.Rows) > 0 {
			for _, diagnostic := range diagnostics.sorted() {
				if diagnostic.Code == "rows_blocked" {
					break
				}
			}
			blocked := false
			for _, row := range matrix.Rows {
				if row.Status == "blocked" {
					blocked = true
					break
				}
			}
			if blocked {
				diagnostics.add("rows_blocked", "/rows")
			}
		}
	} else {
		for _, row := range matrix.Rows {
			result.Rows = append(result.Rows, AcceptanceResultV1Row{ID: row.ID, Status: "valid", Code: "specified"})
		}
	}
	return finishAcceptanceV2Result(result, request.NormalizedFacts, diagnostics, &matrix)
}

func matrixErrCode(err error) string {
	if err == nil {
		return "matrix_json_invalid"
	}
	if err == errV2DuplicateKey {
		return "matrix_duplicate_key"
	}
	if err == errV2TrailingValue {
		return "matrix_noncanonical"
	}
	return "matrix_json_invalid"
}

func finishAcceptanceV2Result(result AcceptanceResultV1, facts NormalizedFactsV1, diagnostics *acceptanceV2Diagnostics, matrix *AcceptanceMatrixV2) AcceptanceResultV1 {
	result.EvaluationScope = facts.EvaluationScope
	result.Diagnostics = diagnostics.sorted()
	result.Code = diagnostics.firstCode()
	if result.Code == "valid" {
		result.Status = "valid"
		if matrix != nil && matrix.EvaluationScope == "plan-publication" {
			result.Code = "specified"
		} else if matrix != nil && matrix.EvaluationScope == "implementation-delivery" {
			result.Code = "observed"
		}
	} else if result.Code == "rows_blocked" || result.Code == "unsupported_class_policy" {
		result.Status = "blocked"
	} else {
		result.Status = "invalid"
	}
	if matrix != nil && result.EvaluationScope == "implementation-delivery" {
		result.Rows = result.Rows[:0]
		for _, row := range matrix.Rows {
			status, code := "valid", "observed"
			if row.Status == "blocked" {
				status, code = "blocked", "blocked"
			}
			if row.AcceptanceClass == "benchmark" || row.AcceptanceClass == "evidence" {
				status, code = "blocked", "unsupported_class_policy"
			}
			if result.Status == "invalid" {
				status, code = "invalid", result.Code
			}
			result.Rows = append(result.Rows, AcceptanceResultV1Row{ID: row.ID, Status: status, Code: code})
		}
	}
	return result
}

// ParseImplementationPlanManifestV2Compatibility is deliberately narrower than
// delivery admission. It proves that the immutable AIDEV-187 source tuple is
// understood, while always returning delivery_admitted=false.
type ImplementationPlanManifestV2CompatibilityResult struct {
	Status           string              `json:"status"`
	Code             string              `json:"code"`
	DeliveryAdmitted bool                `json:"delivery_admitted"`
	PlanSHA256       string              `json:"plan_sha256"`
	ManifestSHA256   string              `json:"manifest_sha256"`
	Rows             []AcceptancePlanRow `json:"rows"`
}

var aidev187CompatibilityRows = []AcceptancePlanRow{
	{ID: "AIDEV-187-1", AcceptanceClass: "authority", Requirement: "The optional schema bridge is admitted by the original-base preflight and full profile tests while current profile, trusted loader, active review scripts, and v3 behavior remain byte-identical."},
	{ID: "AIDEV-187-2", AcceptanceClass: "authority", Requirement: "Exact-base policy loading and resolution ignore untrusted selectors and follow the fixed catalog, profile-admission, considered-set, availability, precedence, and golden-envelope rules."},
	{ID: "AIDEV-187-3", AcceptanceClass: "ordinary", Requirement: "The adopted profile resolves manual Antigravity Gemini planner, Luna implementer, Sol primary reviewer, and Sol final reviewer with exact selected envelopes."},
	{ID: "AIDEV-187-4", AcceptanceClass: "authority", Requirement: "Terra direct selection and same-model Sol role assignments resolve without override or model-inequality trust checks, while context admission remains unavailable."},
	{ID: "AIDEV-187-5", AcceptanceClass: "ordinary", Requirement: "Allowlisted override, both zero-based fallback positions, malformed availability, unsupported catalogs, nonallowed override, exhaustion, and unspecified policy return exact golden envelopes."},
	{ID: "AIDEV-187-6", AcceptanceClass: "resource-bounded", Requirement: "Policy and resolution canonical bytes, null or zero-based fallbackIndex values, bounds, and domain-separated digest vectors are identical on Windows and Linux."},
	{ID: "AIDEV-187-7", AcceptanceClass: "authority", Requirement: "The byte-preserving context consumer rejects self-attestation, keeps the dispatch unavailable, and freezes the exact bounded provider-v1 request, result, module, digest, timeout, and error interface for AIDEV-190."},
	{ID: "AIDEV-187-8", AcceptanceClass: "authority", Requirement: "Packet v4 exactly maps packet v3 including canonical root package-lock admission through 524288 bytes and ordinary 131072-byte endpoints, binds policy/context digests, rejects stale policy, and remains non-authoritative."},
	{ID: "AIDEV-187-9", AcceptanceClass: "authority", Requirement: "Receipt v2 binds policy and context digests at root and every pass, and marker v4 follows the exact grammar and key order while preserving lifecycle, revocation, provenance, privacy, and inactive publication."},
	{ID: "AIDEV-187-10", AcceptanceClass: "authority", Requirement: "Immutable dispatch and package-lock boundary parity preserve packet v3, receipt v1, marker v3, terra-final-v1, and terra-parent bytes/results without invented fields, silent upgrade, reinterpretation, or downgrade."},
	{ID: "AIDEV-187-11", AcceptanceClass: "ordinary", Requirement: "Every model-neutral agent, skill, API, template, documentation, compatibility alias, test, and fixture path is correctly classified and assigned to exactly one slice."},
	{ID: "AIDEV-187-12", AcceptanceClass: "authority", Requirement: "All slices use the exact external dependency lease, preceding-base admission, path allowlists, non-vacuous tests, independent review, protected CI, and restored no-residue status while publishing downstream digests without activating v4."},
}

func ParseImplementationPlanManifestV2Compatibility(planBytes, manifestBytes []byte) ImplementationPlanManifestV2CompatibilityResult {
	planHash := sha256.Sum256(planBytes)
	manifestHash := sha256.Sum256(manifestBytes)
	result := ImplementationPlanManifestV2CompatibilityResult{Status: "invalid", Code: "compatibility_tuple_invalid", DeliveryAdmitted: false, PlanSHA256: hex.EncodeToString(planHash[:]), ManifestSHA256: hex.EncodeToString(manifestHash[:]), Rows: []AcceptancePlanRow{}}
	if len(planBytes) != 44524 || result.PlanSHA256 != "e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744" || len(manifestBytes) != 17392 || result.ManifestSHA256 != "f11f7b638adfec563482163f91d299df00467a3909bb27458cc9da8c6025dabc" {
		return result
	}
	var manifest struct {
		SchemaVersion  string `json:"schema_version"`
		TicketID       string `json:"ticket_id"`
		Repository     string `json:"repository"`
		PlanPath       string `json:"plan_path"`
		PlanSHA256     string `json:"plan_sha256"`
		BaseSHA        string `json:"base_sha"`
		TicketRevision string `json:"ticket_revision"`
		Rows           []struct {
			ID              string `json:"id"`
			AcceptanceClass string `json:"acceptance_class"`
			Requirement     string `json:"requirement"`
		} `json:"rows"`
	}
	if scanAcceptanceV2JSON(manifestBytes) != nil {
		return result
	}
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	if decoder.Decode(&manifest) != nil {
		return result
	}
	if manifest.SchemaVersion != AcceptanceManifestV2SchemaVersion || manifest.TicketID != "AIDEV-187" || manifest.Repository != "Zkrausman/pi-sampler" || manifest.PlanPath != "docs/techPlans/AIDEV-187-implementation-plan.md" || manifest.PlanSHA256 != result.PlanSHA256 || manifest.BaseSHA != "3d858a0d4f8219f5ca1db13ad1de72e35ee09758" || manifest.TicketRevision != "08967f81071a97e0fa0adb2430906e04fd448413ad41546e6f0b19fa5d24f5d4" || len(manifest.Rows) != len(aidev187CompatibilityRows) {
		return result
	}
	for index, row := range manifest.Rows {
		expected := aidev187CompatibilityRows[index]
		if row.ID != expected.ID || row.AcceptanceClass != expected.AcceptanceClass || row.Requirement != expected.Requirement {
			return result
		}
		result.Rows = append(result.Rows, AcceptancePlanRow{ID: row.ID, AcceptanceClass: row.AcceptanceClass, Requirement: row.Requirement})
	}
	result.Status = "valid"
	result.Code = "compatibility_tuple_understood"
	return result
}

func ParseImplementationPlanManifestV2CompatibilityFile(planPath, manifestPath string) (ImplementationPlanManifestV2CompatibilityResult, error) {
	plan, err := os.ReadFile(planPath)
	if err != nil {
		return ImplementationPlanManifestV2CompatibilityResult{Status: "invalid", Code: "compatibility_tuple_invalid", DeliveryAdmitted: false}, err
	}
	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		return ImplementationPlanManifestV2CompatibilityResult{Status: "invalid", Code: "compatibility_tuple_invalid", DeliveryAdmitted: false}, err
	}
	return ParseImplementationPlanManifestV2Compatibility(plan, manifest), nil
}

// externalIdentity is intentionally represented with scalar fields so the
// common evaluator can compare POSIX and Windows handles without importing a
// platform-specific syscall type.
type externalIdentity struct {
	Device     uint64
	File       uint64
	FileHigh   uint64
	Links      uint64
	Size       int64
	Mode       uint32
	Modified   int64
	Blocks     uint64
	HasDevice  bool
	HasFile    bool
	HasFile128 bool
	HasLinks   bool
	HasBlocks  bool
	Type       uint32
	Reparse    bool
}

type externalAncestor struct {
	Path     string
	Identity externalIdentity
}

type externalExcludedPath struct {
	Path      string
	Ancestors []externalAncestor
}

type ExternalEvidenceRoot struct {
	Path       string
	Identity   externalIdentity
	Ancestors  []externalAncestor
	Exclusions []externalExcludedPath
	Device     uint64
}

type ExternalEvidenceInventoryEntry struct {
	Path     string `json:"path"`
	Type     string `json:"type"`
	Bytes    int64  `json:"bytes"`
	Identity string `json:"identity"`
	SHA256   string `json:"sha256"`
}

type ExternalEvidenceInventory struct {
	Entries []ExternalEvidenceInventoryEntry `json:"entries"`
}

// collectExternalEntries is the shared bounded enumeration seam. Platform
// walkers provide a one-batch reader (native Readdir(1) on Windows/POSIX), so
// entry 1,001 is observed only to reject it and is never retained.
func collectExternalEntries(next func() ([]os.FileInfo, error)) ([]os.FileInfo, error) {
	entries := make([]os.FileInfo, 0, externalRootMaxEntries)
	for {
		batch, err := next()
		if len(batch) > 0 {
			if len(entries)+len(batch) > externalRootMaxEntries {
				return nil, &ExternalEvidenceError{Code: "artifact_too_large"}
			}
			entries = append(entries, batch...)
		}
		if err == io.EOF {
			return entries, nil
		}
		if err != nil {
			return nil, &ExternalEvidenceError{Code: "evidence_identity_changed", Err: err}
		}
	}
}

type ExternalEvidenceError struct {
	Code string
	Err  error
}

func (e *ExternalEvidenceError) Error() string {
	if e.Err == nil {
		return e.Code
	}
	return e.Code
}
func (e *ExternalEvidenceError) Unwrap() error { return e.Err }

func externalIdentityFromInfo(info os.FileInfo) externalIdentity {
	identity := externalIdentity{Size: info.Size(), Mode: uint32(info.Mode()), Modified: info.ModTime().UnixNano(), Type: uint32(info.Mode() & os.ModeType), Reparse: info.Mode()&os.ModeSymlink != 0}
	value := reflect.ValueOf(info.Sys())
	if value.IsValid() && value.Kind() == reflect.Pointer && !value.IsNil() {
		value = value.Elem()
	}
	if value.IsValid() && value.Kind() == reflect.Struct {
		read := func(names ...string) (uint64, bool) {
			for _, name := range names {
				field := value.FieldByName(name)
				if field.IsValid() && field.CanUint() {
					return field.Uint(), true
				}
			}
			return 0, false
		}
		if v, ok := read("Dev", "VolumeSerialNumber"); ok {
			identity.Device, identity.HasDevice = v, true
		}
		if v, ok := read("Ino", "FileIndex", "FileIndexLow"); ok {
			identity.File, identity.HasFile = v, true
		}
		if v, ok := read("FileIndexHigh"); ok {
			identity.FileHigh = v
		}
		if v, ok := read("Nlink", "NumberOfLinks"); ok {
			identity.Links, identity.HasLinks = v, true
		}
		if v, ok := read("Blocks"); ok {
			identity.Blocks, identity.HasBlocks = v, true
		}
	}
	return identity
}

func externalIdentitiesEqual(left, right externalIdentity) bool {
	if left.HasDevice && right.HasDevice && left.Device != right.Device {
		return false
	}
	if left.HasFile && right.HasFile && (left.File != right.File || left.FileHigh != right.FileHigh) {
		return false
	}
	if left.HasLinks && right.HasLinks && left.Links != right.Links {
		return false
	}
	if left.HasBlocks && right.HasBlocks && left.Blocks != right.Blocks {
		return false
	}
	return left.Size == right.Size && left.Mode == right.Mode && left.Modified == right.Modified && left.Type == right.Type && left.Reparse == right.Reparse
}

// Ancestor directories are authenticated by immutable handle identity and
// type/device properties only. Directory size, mtime, link count, and blocks
// can change during unrelated sibling activity and are not replacement proof.
func externalAncestorIdentitiesEqual(left, right externalIdentity) bool {
	if left.HasDevice != right.HasDevice || left.HasFile != right.HasFile || left.HasFile128 != right.HasFile128 {
		return false
	}
	if left.HasDevice && left.Device != right.Device {
		return false
	}
	if left.HasFile && (left.File != right.File || left.FileHigh != right.FileHigh) {
		return false
	}
	return left.Type == right.Type && left.Reparse == right.Reparse
}

func externalIdentityText(identity externalIdentity) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d:%d:%d:%d:%d:%t:%t", identity.Device, identity.FileHigh, identity.File, identity.Links, identity.Size, identity.Mode, identity.Modified, identity.Blocks, identity.Type, identity.HasFile128, identity.Reparse)
}

func inventoryJSON(inventory ExternalEvidenceInventory) []byte {
	data, _ := jsonBytes(inventory)
	return data
}

func normalizeExternalArtifact(value any, extras []any) (AcceptanceArtifactV2, bool) {
	switch artifact := value.(type) {
	case AcceptanceArtifactV2:
		return artifact, true
	case *AcceptanceArtifactV2:
		if artifact != nil {
			return *artifact, true
		}
	case string:
		result := AcceptanceArtifactV2{Path: artifact}
		for _, extra := range extras {
			switch typed := extra.(type) {
			case int:
				result.Bytes = int64(typed)
			case int64:
				result.Bytes = typed
			case string:
				if validV2Digest(typed) {
					result.SHA256 = typed
				}
			}
		}
		return result, true
	}
	return AcceptanceArtifactV2{}, false
}

func inventoryDigest(inventory ExternalEvidenceInventory) string {
	data := inventoryJSON(inventory)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func ExternalEvidenceInventorySHA256(inventory ExternalEvidenceInventory) string {
	return inventoryDigest(inventory)
}
