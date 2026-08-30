package deliveryevidence

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	AcceptanceMatrixV2SchemaVersion, AcceptanceManifestV2SchemaVersion = "acceptance-matrix/v2", "implementation-plan-manifest/v2"
	NormalizedFactsV1Format, NormalizedFactsV1Version                  = "pi-sampler.delivery-normalized-facts", 1
	AcceptanceResultV1Format, AcceptanceResultV1Version                = "pi-sampler.delivery-acceptance-result", 1
	AcceptanceV2RequestFormat, AcceptanceV2RequestVersion              = "pi-sampler.delivery-acceptance-v2-request", 1
	ExternalEvidenceInventoryFormat, ExternalEvidenceInventoryVersion  = "pi-sampler.external-evidence-inventory/v1", 1
	maxAcceptanceMatrixV2Bytes                                         = 2 * 1024 * 1024
	maxV2Inventory                                                     = 2 * 1024 * 1024
	maxV2String                                                        = 2048
	maxV2Rows                                                          = 128
	maxV2Artifacts                                                     = 32
	maxV2Argv                                                          = 32
	maxAcceptanceV2ArtifactBytes                                       = 10 * 1024 * 1024
	maxV2Evidence                                                      = 32 * 1024 * 1024
	maxAcceptanceV2MatrixBytes                                         = 100 * 1024 * 1024
	maxV2Depth                                                         = 16
	maxV2Skew                                                          = 5 * time.Minute
	maxV2Duration                                                      = 15 * time.Minute
)

var (
	v2RevisionRe      = regexp.MustCompile(`^[a-f0-9]{40}(?:[a-f0-9]{24})?$`)
	v2DigestRe        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	v2TicketRe        = regexp.MustCompile(`^[A-Z][A-Z0-9]+-[0-9]+$`)
	v2IdentifierRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$`)
	v2RepositoryRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	v2OpaqueRootRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	v2BlockerCodeRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	v2PathComponentRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+,-]*$`)
	v2VerifierRe      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]*$`)
)

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
type (
	blockerV2      = AcceptanceBlockerV2
	policyV2       = AcceptancePolicyV2
	classV2        = AcceptanceClassPolicyV2
	requestV2      = AcceptanceV2Request
	evidenceRoot   = ExternalEvidenceRoot
	inventory      = ExternalEvidenceInventory
	inventoryEntry = ExternalEvidenceInventoryEntry
)

func DecodeAcceptanceV2Request(data []byte) (AcceptanceV2Request, error) {
	var request requestV2
	if len(data) == 0 || len(data) > 12*1024*1024 || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return request, errors.New("acceptance-v2 request exceeds limit or is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanJSONValue(decoder, 0, &jsonBudget{}); err != nil {
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

type v2Diagnostic struct {
	Code string
	Path string
}
type v2Diagnostics struct{ items map[string]v2Diagnostic }

var v2MatrixMembers = strings.Fields("schema_version manifest_schema_version evaluation_scope repository ticket_id ticket_revision profile_path profile_sha256 base_sha head_sha pull_request_number plan_path plan_sha256 manifest_path manifest_sha256 manifest_contract_path manifest_contract_sha256 manifest_validator_path manifest_validator_sha256 matrix_contract_path matrix_contract_sha256 policy_path policy_sha256 evidence_root_id generated_at rows")

const (
	schemaInvalid, bindingMismatch, pathMismatch   = "matrix_schema_invalid", "binding_mismatch", "artifact_path_mismatch"
	rootInvalid, tooLarge, pathInvalid             = "evidence_root_invalid", "artifact_too_large", "evidence_path_invalid"
	identityChanged, artifactDigest, scopeMismatch = "evidence_identity_changed", "artifact_digest_mismatch", "scope_status_mismatch"
	verifierMismatch, policyMissing, v2RootPath    = "verifier_policy_mismatch", "policy_missing", "/evidence_root"
	maxV2Artifact, maxV2Total, maxMatrixInput      = maxAcceptanceV2ArtifactBytes, maxAcceptanceV2MatrixBytes, maxAcceptanceMatrixV2Bytes
	mSchema, mfSchema, factsFmt, factsVer          = AcceptanceMatrixV2SchemaVersion, AcceptanceManifestV2SchemaVersion, NormalizedFactsV1Format, NormalizedFactsV1Version
	resultFmt, resultVer, requestFmt, requestVer   = AcceptanceResultV1Format, AcceptanceResultV1Version, AcceptanceV2RequestFormat, AcceptanceV2RequestVersion
	inventoryFmt, inventoryVer                     = ExternalEvidenceInventoryFormat, ExternalEvidenceInventoryVersion
)

var v2Precedence = strings.Fields("usage_invalid git_unavailable trusted_base_invalid activation_absent trusted_blob_invalid trusted_digest_mismatch candidate_root_invalid source_mutated " + tooLarge + " manifest_validator_failed manifest_version_unsupported matrix_duplicate_key matrix_json_invalid " + schemaInvalid + " matrix_noncanonical version_pair_mixed version_pair_unsupported " + bindingMismatch + " " + pathMismatch + " digest_mismatch row_duplicate row_missing row_unknown row_reordered row_binding_mismatch " + scopeMismatch + " " + rootInvalid + " " + pathInvalid + " " + identityChanged + " " + artifactDigest + " " + policyMissing + " policy_ambiguous " + verifierMismatch + " unsupported_class_policy rows_blocked")

func v2Priority(code string) int       { return slices.Index(v2Precedence, code) + 1 }
func newV2Diagnostics() *v2Diagnostics { return &v2Diagnostics{items: map[string]v2Diagnostic{}} }
func (d *v2Diagnostics) add(code, path string) {
	if v2Priority(code) == 0 {
		code = schemaInvalid
	}
	if path == "" || !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\r\n\t") {
		path = "/matrix"
	}
	d.items[code+"\x00"+path] = v2Diagnostic{Code: code, Path: path}
}
func (d *v2Diagnostics) sorted() []AcceptanceDiagnosticV1 {
	items := make([]v2Diagnostic, 0, len(d.items))
	for _, item := range d.items {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		pi, pj := v2Priority(items[i].Code), v2Priority(items[j].Code)
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
func (d *v2Diagnostics) has(code string) bool {
	for _, item := range d.items {
		if item.Code == code {
			return true
		}
	}
	return false
}
func (d *v2Diagnostics) firstCode() string {
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

func scanV2JSON(data []byte, maximum, depthLimit, arrayLimit int) error {
	if len(data) == 0 || len(data) > maximum || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return errV2JSONInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	nodes := 0
	var scan func(int) error
	scan = func(depth int) error {
		if depth > depthLimit || nodes > 100_000 {
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
				name, ok := key.(string)
				if err != nil || !ok {
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
			for count := 0; decoder.More(); count++ {
				if count >= arrayLimit {
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
	if err := scan(0); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return errV2TrailingValue
	} else if err != io.EOF {
		return errV2JSONInvalid
	}
	return nil
}
func scanV2Data(data []byte) error {
	return scanV2JSON(data, maxMatrixInput, maxV2Depth, maxV2Rows*maxV2Artifacts)
}
func hasFields(object map[string]json.RawMessage, members ...string) bool {
	for _, member := range members {
		if value, ok := object[member]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}
func rawObject(data []byte) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	err := json.Unmarshal(data, &object)
	return object, err == nil && object != nil
}
func validRawEvidence(data []byte) bool {
	evidence, ok := rawObject(data)
	if !ok || !hasFields(evidence, "verifier", "exit_status", "started_at", "completed_at", "artifacts") {
		return false
	}
	verifier, ok := rawObject(evidence["verifier"])
	if !ok || !hasFields(verifier, "id", "version", "environment", "argv") {
		return false
	}
	var artifacts []map[string]json.RawMessage
	if json.Unmarshal(evidence["artifacts"], &artifacts) != nil {
		return false
	}
	for _, artifact := range artifacts {
		if !hasFields(artifact, "name", "path", "sha256", "bytes") {
			return false
		}
	}
	return true
}
func validRawBlocker(data []byte) bool {
	blocker, ok := rawObject(data)
	_, hasParent := blocker["blocked_by"]
	return ok && hasParent && hasFields(blocker, "code", "reason")
}
func notNull(value json.RawMessage) bool {
	return value != nil && !bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}
func shapeV2(data []byte, matrix matrixV2) bool {
	root, ok := rawObject(data)
	if !ok || !hasFields(root, v2MatrixMembers...) {
		return false
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(root["rows"], &rows) != nil || len(rows) != len(matrix.Rows) {
		return false
	}
	for index, row := range rows {
		if !hasFields(row, "id", "acceptance_class", "requirement", "status") {
			return false
		}
		spec, specOK := row["specification"]
		evidence, evidenceOK := row["evidence"]
		blocker, blockerOK := row["blocker"]
		shapeOK := false
		switch {
		case matrix.EvaluationScope == "plan-publication":
			shapeOK = specOK && !evidenceOK && !blockerOK
		case matrix.Rows[index].Status == "observed":
			shapeOK = evidenceOK && !specOK && !blockerOK
		case matrix.Rows[index].Status == "blocked":
			shapeOK = blockerOK && !specOK && !evidenceOK
		}
		if !shapeOK || notNull(spec) && !validRawEvidence(spec) || notNull(evidence) && !validRawEvidence(evidence) || notNull(blocker) && !validRawBlocker(blocker) {
			return false
		}
	}
	return true
}
func decodeV2(data []byte) (matrixV2, string) {
	if err := scanV2Data(data); err != nil {
		switch err {
		case errV2DuplicateKey:
			return matrixV2{}, "matrix_duplicate_key"
		case errV2TrailingValue:
			return matrixV2{}, "matrix_noncanonical"
		default:
			return matrixV2{}, "matrix_json_invalid"
		}
	}
	var matrix matrixV2
	if !decodeStrict(data, &matrix) {
		return matrixV2{}, schemaInvalid
	}
	if !shapeV2(data, matrix) {
		return matrixV2{}, schemaInvalid
	}
	if !isCanonicalAcceptanceMatrixV2(data, matrix) {
		return matrixV2{}, "matrix_noncanonical"
	}
	return matrix, ""
}
func decodeStrict(data []byte, target any) bool {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	var extra any
	return decoder.Decode(&extra) == io.EOF
}
func validDefault(value string, maximum int) bool {
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
func validASCII(value string, maximum int) bool {
	return v2VerifierRe.MatchString(value) && validDefault(value, maximum)
}
func validPattern(re *regexp.Regexp, value string, maximum int) bool {
	return re.MatchString(value) && len([]byte(value)) <= maximum
}
func validRevision(value string) bool { return v2RevisionRe.MatchString(value) }
func validV2Digest(value string) bool { return v2DigestRe.MatchString(value) }
func validID(value string) bool {
	return v2IdentifierRe.MatchString(value) && len([]byte(value)) <= 128
}
func validV2PortablePath(value string, maximum int) bool {
	if !validDefault(value, maximum) || strings.ContainsAny(value, `\\%:`) || strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.Contains(value, "//") || v2WindowsDriveRe.MatchString(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if len([]byte(part)) > 255 || part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || !validV2PathComponent(part) {
			return false
		}
	}
	return true
}

var v2WindowsDriveRe = regexp.MustCompile(`^[A-Za-z]:`)

func validV2PathComponent(value string) bool {
	if value == "" || !v2PathComponentRe.MatchString(value) {
		return false
	}
	upper := strings.ToUpper(strings.SplitN(value, ".", 2)[0])
	switch upper {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$":
		return false
	}
	if len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9' {
		return false
	}
	return true
}
func validV2ArtifactPath(value string) bool {
	return validV2PortablePath(value, 240) && len(strings.Split(value, "/")) <= externalRootMaxDepth
}
func parseTimeV2(value string) (time.Time, bool) {
	if len(value) != 24 || !regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`).MatchString(value) {
		return time.Time{}, false
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	return parsed.UTC(), err == nil && parsed.UTC().Format("2006-01-02T15:04:05.000Z") == value
}
func siblingManifest(planPath string) string {
	const suffix = "-implementation-plan.md"
	if !strings.HasSuffix(planPath, suffix) {
		return ""
	}
	return strings.TrimSuffix(planPath, suffix) + "-acceptance-manifest-v2.json"
}
func validateNormalizedFactsV1Shape(facts factsV1, d *v2Diagnostics) {
	bad := func(ok bool, path string) {
		if !ok {
			d.add(bindingMismatch, path)
		}
	}
	bad(facts.Format == factsFmt && facts.Version == factsVer, "/normalized_facts")
	bad(validPattern(v2RepositoryRe, facts.Repository, 256), "/normalized_facts/repository")
	bad(validPattern(v2TicketRe, facts.TicketID, 32), "/normalized_facts/ticketId")
	bad(validRevision(facts.TicketRevision) && validRevision(facts.BaseSHA) && validRevision(facts.HeadSHA) && facts.BaseSHA != facts.HeadSHA, "/normalized_facts/baseSha")
	bad(facts.ProfilePath == "profiles/pi-sampler.json" && validV2Digest(facts.ProfileSHA256) && facts.PolicySHA256 == facts.ProfileSHA256, "/normalized_facts/profilePath")
	bad(facts.ManifestSchemaVersion == mfSchema && validV2Digest(facts.PlanSHA256) && validV2Digest(facts.ManifestSHA256) && validV2Digest(facts.ManifestContractSHA256) && validV2Digest(facts.ManifestValidatorSHA256) && validV2Digest(facts.MatrixContractSHA256), "/normalized_facts/digests")
	bad(validV2PortablePath(facts.PlanPath, 256) && validV2PortablePath(facts.ManifestPath, 256) && facts.ManifestPath == siblingManifest(facts.PlanPath), "/normalized_facts/planPath")
	bad(facts.PullRequestNumber >= 1 && facts.PullRequestNumber <= 1_000_000_000, "/normalized_facts/pullRequestNumber")
	bad(facts.EvaluationScope == "plan-publication" || facts.EvaluationScope == "implementation-delivery", "/normalized_facts/evaluationScope")
	bad(len(facts.Rows) >= 1 && len(facts.Rows) <= maxV2Rows, "/normalized_facts/rows")
	seen := map[string]bool{}
	for index, row := range facts.Rows {
		path := fmt.Sprintf("/normalized_facts/rows/%d", index)
		bad(validID(row.ID) && validDefault(row.AcceptanceClass, 64) && validDefault(row.Requirement, maxV2String), path)
		if seen[row.ID] {
			d.add(bindingMismatch, path+"/id")
		}
		seen[row.ID] = true
	}
}

type v2Rule struct {
	name string
	kind byte
	max  int
}

var v2RootRules = []v2Rule{{"Repository", 'r', 256}, {"TicketID", 't', 32}, {"TicketRevision", 'v', 0}, {"ProfileSHA256", 'd', 0}, {"PlanSHA256", 'd', 0}, {"ManifestSHA256", 'd', 0}, {"ManifestContractSHA256", 'd', 0}, {"ManifestValidatorSHA256", 'd', 0}, {"MatrixContractSHA256", 'd', 0}, {"PolicySHA256", 'd', 0}, {"PullRequestNumber", 'n', 0}, {"PlanPath", 'p', 256}, {"ManifestPath", 'p', 256}, {"EvidenceRootID", 'o', 128}, {"Rows", 'l', maxV2Rows}}
var v2ComparableFields = strings.Fields("Repository TicketID TicketRevision ProfilePath ProfileSHA256 BaseSHA HeadSHA PlanPath PlanSHA256 ManifestPath ManifestSHA256 ManifestSchemaVersion ManifestContractSHA256 ManifestValidatorSHA256 MatrixContractSHA256 PolicySHA256 EvaluationScope")

func v2FieldPath(name string) string {
	field, _ := reflect.TypeOf(AcceptanceMatrixV2{}).FieldByName(name)
	return "/" + strings.Split(field.Tag.Get("json"), ",")[0]
}
func validV2Rule(value reflect.Value, kind byte, max int) bool {
	switch kind {
	case 'r':
		return validPattern(v2RepositoryRe, value.String(), max)
	case 't':
		return validPattern(v2TicketRe, value.String(), max)
	case 'v':
		return validRevision(value.String())
	case 'd':
		return validV2Digest(value.String())
	case 'p':
		return validV2PortablePath(value.String(), max)
	case 'o':
		return validPattern(v2OpaqueRootRe, value.String(), max)
	case 'n':
		return value.Int() >= 1 && value.Int() <= 1_000_000_000
	case 'l':
		return value.Len() >= 1 && value.Len() <= max
	}
	return false
}
func validateV2Root(matrix matrixV2, facts factsV1, d *v2Diagnostics) (time.Time, bool) {
	valid := true
	bad := func(ok bool, code, path string) {
		if !ok {
			d.add(code, path)
			valid = false
		}
	}
	bad(matrix.SchemaVersion == mSchema && matrix.ManifestSchemaVersion == mfSchema, "manifest_version_unsupported", "/schema_version")
	bad(matrix.EvaluationScope == "plan-publication" || matrix.EvaluationScope == "implementation-delivery", schemaInvalid, "/evaluation_scope")
	bad(matrix.ProfilePath == "profiles/pi-sampler.json" && matrix.PolicyPath == "profiles/pi-sampler.json", bindingMismatch, "/profile_path")
	bad(matrix.ManifestContractPath == "contracts/implementation-plan-manifest-v2.mjs" && matrix.ManifestValidatorPath == "scripts/validate-implementation-plan.mjs" && matrix.MatrixContractPath == "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json", bindingMismatch, "/manifest_contract_path")
	matrixValue := reflect.ValueOf(matrix)
	for _, rule := range v2RootRules {
		bad(validV2Rule(matrixValue.FieldByName(rule.name), rule.kind, rule.max), schemaInvalid, v2FieldPath(rule.name))
	}
	bad(matrix.ProfileSHA256 == matrix.PolicySHA256, bindingMismatch, "/policy_sha256")
	bad(validRevision(matrix.BaseSHA) && validRevision(matrix.HeadSHA) && matrix.BaseSHA != matrix.HeadSHA, bindingMismatch, "/head_sha")
	generated, generatedOK := parseTimeV2(matrix.GeneratedAt)
	bad(generatedOK, schemaInvalid, "/generated_at")
	bad(facts.Format == factsFmt && facts.Version == factsVer, bindingMismatch, "/normalized_facts")
	return generated, valid
}
func validateV2Facts(matrix matrixV2, facts factsV1, d *v2Diagnostics) {
	matrixValue, factsValue := reflect.ValueOf(matrix), reflect.ValueOf(facts)
	for _, name := range v2ComparableFields {
		path := v2FieldPath(name)
		if matrixValue.FieldByName(name).String() != factsValue.FieldByName(name).String() {
			code := bindingMismatch
			if strings.HasSuffix(path, "sha256") {
				code = "digest_mismatch"
			}
			d.add(code, path)
		}
	}
	if matrix.PullRequestNumber != facts.PullRequestNumber {
		d.add(bindingMismatch, "/pull_request_number")
	}
	if len(matrix.Rows) != len(facts.Rows) {
		if len(matrix.Rows) < len(facts.Rows) {
			d.add("row_missing", "/rows")
		} else {
			d.add("row_unknown", "/rows")
		}
	}
}
func validateV2Rows(matrix matrixV2, facts factsV1, d *v2Diagnostics) {
	if len(matrix.Rows) > maxV2Rows {
		return
	}
	factByID, seen := map[string]factsRowV1{}, map[string]bool{}
	for _, row := range facts.Rows {
		factByID[row.ID] = row
	}
	for index, row := range matrix.Rows {
		path := fmt.Sprintf("/rows/%d", index)
		if seen[row.ID] {
			d.add("row_duplicate", path+"/id")
		} else {
			seen[row.ID] = true
		}
		expected, exists := factByID[row.ID]
		if !exists {
			d.add("row_unknown", path+"/id")
		} else if row.AcceptanceClass != expected.AcceptanceClass || row.Requirement != expected.Requirement {
			d.add("row_binding_mismatch", path)
		}
		if !validID(row.ID) || !validDefault(row.Requirement, maxV2String) || !validDefault(row.AcceptanceClass, 64) {
			d.add(schemaInvalid, path)
		}
	}
	for index, expected := range facts.Rows {
		if index >= len(matrix.Rows) {
			d.add("row_missing", fmt.Sprintf("/rows/%d", index))
			continue
		}
		if matrix.Rows[index].ID != expected.ID {
			d.add("row_reordered", fmt.Sprintf("/rows/%d/id", index))
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
					d.add("row_reordered", "/rows")
					break
				}
			}
		}
	}
	for index, row := range matrix.Rows {
		validateV2RowShape(row, matrix.EvaluationScope, fmt.Sprintf("/rows/%d", index), d)
	}
}
func invalidV2(d *v2Diagnostics, ok bool, path string) {
	if !ok {
		d.add(schemaInvalid, path)
	}
}
func validateV2RowShape(row rowV2, scope, path string, d *v2Diagnostics) {
	switch row.AcceptanceClass {
	case "ordinary", "authority", "requirement", "resource-bounded", "concurrency", "evidence", "benchmark":
	default:
		invalidV2(d, false, path+"/acceptance_class")
	}
	invalidV2(d, validDefault(row.ID, 128) && validID(row.ID), path+"/id")
	invalidV2(d, validDefault(row.Requirement, maxV2String), path+"/requirement")
	if scope == "plan-publication" {
		if row.Status != "specified" || row.Specification == nil || row.Evidence != nil || row.Blocker != nil {
			d.add(scopeMismatch, path+"/status")
			return
		}
		validateV2EvidenceShape(*row.Specification, path+"/specification", d)
		return
	}
	if scope != "implementation-delivery" {
		return
	}
	switch row.Status {
	case "observed":
		if row.Evidence == nil || row.Specification != nil || row.Blocker != nil {
			d.add(scopeMismatch, path+"/status")
		} else {
			validateV2EvidenceShape(*row.Evidence, path+"/evidence", d)
		}
	case "blocked":
		if row.Blocker == nil || row.Evidence != nil || row.Specification != nil {
			d.add(scopeMismatch, path+"/status")
		} else {
			validateV2BlockerShape(*row.Blocker, path+"/blocker", d)
		}
	default:
		d.add(scopeMismatch, path+"/status")
	}
}
func validateV2EvidenceShape(evidence evidenceV2, path string, d *v2Diagnostics) {
	invalidV2(d, validASCII(evidence.Verifier.ID, 128) && validASCII(evidence.Verifier.Version, 128), path+"/verifier")
	invalidV2(d, evidence.Verifier.Environment == "local" || evidence.Verifier.Environment == "ci" || evidence.Verifier.Environment == "review" || evidence.Verifier.Environment == "external", path+"/verifier/environment")
	invalidV2(d, len(evidence.Verifier.Argv) >= 1 && len(evidence.Verifier.Argv) <= maxV2Argv, path+"/verifier/argv")
	for index, arg := range evidence.Verifier.Argv {
		invalidV2(d, validDefault(arg, 256), fmt.Sprintf("%s/verifier/argv/%d", path, index))
	}
	invalidV2(d, evidence.ExitStatus == 0, path+"/exit_status")
	started, startOK := parseTimeV2(evidence.StartedAt)
	completed, completeOK := parseTimeV2(evidence.CompletedAt)
	invalidV2(d, startOK, path+"/started_at")
	invalidV2(d, completeOK, path+"/completed_at")
	if startOK && completeOK && (completed.Before(started) || completed.Sub(started) > maxV2Duration) {
		d.add(schemaInvalid, path+"/completed_at")
	}
	invalidV2(d, len(evidence.Artifacts) >= 1 && len(evidence.Artifacts) <= maxV2Artifacts, path+"/artifacts")
	seenNames, seenPaths, aggregate := map[string]bool{}, map[string]bool{}, int64(0)
	for index, artifact := range evidence.Artifacts {
		artifactPath := fmt.Sprintf("%s/artifacts/%d", path, index)
		invalidV2(d, validDefault(artifact.Name, 128), artifactPath+"/name")
		if !validV2ArtifactPath(artifact.Path) {
			d.add(pathInvalid, artifactPath+"/path")
		}
		pathKey, nameKey := externalIdentityKey(artifact.Path), externalIdentityKey(artifact.Name)
		invalidV2(d, !seenNames[nameKey] && !seenPaths[pathKey], artifactPath)
		seenNames[nameKey], seenPaths[pathKey] = true, true
		if !validV2Digest(artifact.SHA256) || artifact.Bytes < 0 {
			d.add(schemaInvalid, artifactPath)
		} else if artifact.Bytes > maxV2Artifact {
			d.add(tooLarge, artifactPath+"/bytes")
		}
		aggregate += artifact.Bytes
		if aggregate > maxV2Evidence {
			d.add(tooLarge, path+"/artifacts")
		}
	}
}
func validateV2BlockerShape(blocker blockerV2, path string, d *v2Diagnostics) {
	if !v2BlockerCodeRe.MatchString(blocker.Code) || len([]byte(blocker.Code)) > 64 {
		d.add(schemaInvalid, path+"/code")
	}
	if !validDefault(blocker.Reason, maxV2String) {
		d.add(schemaInvalid, path+"/reason")
	}
	if blocker.BlockedBy != nil && !validID(*blocker.BlockedBy) {
		d.add(schemaInvalid, path+"/blocked_by")
	}
}
func policyFromV2(data json.RawMessage) (policyV2, bool) {
	if len(data) == 0 || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return policyV2{}, false
	}
	var policy policyV2
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&policy); err != nil || len(policy.Classes) == 0 || len(policy.Classes) > 32 {
		return policyV2{}, false
	}
	return policy, true
}
func classesForV2(policy policyV2, acceptanceClass string) ([]classV2, bool) {
	matches := make([]classV2, 0, 2)
	for _, class := range policy.Classes {
		if class.ID == acceptanceClass || acceptanceClass == "evidence" && class.Kind == "evidence" || acceptanceClass == "benchmark" && class.Kind == "benchmark" {
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
func eachV2Evidence(matrix matrixV2, visit func(int, string, *evidenceV2)) {
	for index := range matrix.Rows {
		row := &matrix.Rows[index]
		field, evidence := "evidence", row.Evidence
		if matrix.EvaluationScope == "plan-publication" {
			field, evidence = "specification", row.Specification
		} else if row.Status != "observed" {
			continue
		}
		if evidence != nil {
			visit(index, field, evidence)
		}
	}
}
func validateV2EvidenceTimes(matrix matrixV2, generated time.Time, d *v2Diagnostics) {
	if generated.IsZero() {
		return
	}
	eachV2Evidence(matrix, func(index int, field string, evidence *evidenceV2) {
		started, startedOK := parseTimeV2(evidence.StartedAt)
		completed, completeOK := parseTimeV2(evidence.CompletedAt)
		if startedOK && completeOK && (started.After(generated) || completed.After(generated)) {
			d.add(schemaInvalid, fmt.Sprintf("/rows/%d/%s/completed_at", index, field))
		}
	})
}
func validateV2PolicyAndArtifacts(matrix matrixV2, policy policyV2, policyOK bool, root *evidenceRoot, d *v2Diagnostics) {
	eachV2Evidence(matrix, func(index int, field string, evidence *evidenceV2) {
		row, path := matrix.Rows[index], fmt.Sprintf("/rows/%d", index)
		publication := field == "specification"
		validateV2Artifacts(root, *evidence, path+"/"+field, publication, d)
		if publication {
			return
		}
		if row.AcceptanceClass == "evidence" || row.AcceptanceClass == "benchmark" {
			d.add("unsupported_class_policy", path+"/acceptance_class")
			return
		}
		if !policyOK {
			d.add(policyMissing, path+"/evidence/verifier")
			return
		}
		matches, found := classesForV2(policy, row.AcceptanceClass)
		if !found {
			d.add(policyMissing, path+"/acceptance_class")
			return
		}
		if len(matches) != 1 {
			d.add("policy_ambiguous", path+"/acceptance_class")
			return
		}
		class, nonInventory := matches[0], len(evidence.Artifacts)
		for _, artifact := range evidence.Artifacts {
			if artifact.Name == AcceptanceV2InventoryReportName {
				nonInventory--
			}
		}
		if nonInventory == 0 || row.AcceptanceClass == "requirement" && nonInventory != 1 {
			d.add(verifierMismatch, path+"/evidence/artifacts")
			return
		}
		expectedEnvironment, expectedArgv := class.Environment, class.Command
		if row.AcceptanceClass == "requirement" {
			expectedEnvironment, expectedArgv = "external", []string{"external:wiki-requirement"}
		}
		verifier := evidence.Verifier
		if class.ID != row.AcceptanceClass || (row.AcceptanceClass == "requirement" && class.Kind != "requirement") || verifier.ID != class.Verifier || verifier.Environment != expectedEnvironment || !equalStringSlice(verifier.Argv, expectedArgv) || class.Version != "" && verifier.Version != class.Version {
			d.add(verifierMismatch, path+"/evidence/verifier")
		}
	})
}
func addV2ExternalError(d *v2Diagnostics, err error, path string) {
	if externalError, ok := err.(*ExternalEvidenceError); ok {
		switch externalError.Code {
		case tooLarge, pathInvalid, identityChanged, artifactDigest:
			d.add(externalError.Code, path)
			return
		}
	}
	d.add(rootInvalid, path)
}
func validatePlanValidatorReport(data []byte) bool {
	if len(data) == 0 || len(data) > maxV2Artifact || scanV2Data(data) != nil {
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
	if len(data) == 0 || len(data) > maxV2Artifact || !utf8.Valid(data) || bytes.Contains(data, []byte{0}) {
		return false
	}
	text := string(data)
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	anchored, inFence := 0, false
	for _, line := range lines {
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
			inFence = !inFence
			continue
		}
		if strings.HasPrefix(line, "decision:") {
			if inFence || line != "decision: approved" {
				return false
			}
			anchored++
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

func validateV2Artifacts(root *evidenceRoot, evidence evidenceV2, path string, publication bool, d *v2Diagnostics) {
	if root == nil {
		d.add(rootInvalid, v2RootPath)
		return
	}
	var validatorArtifact, reviewArtifact *artifactV2
	verified := make(map[string][]byte, len(evidence.Artifacts))
	for index, artifact := range evidence.Artifacts {
		artifactPath := fmt.Sprintf("%s/artifacts/%d", path, index)
		data, err := ReadVerifiedArtifact(root, artifact)
		if err != nil {
			code := identityChanged
			if externalError, ok := err.(*ExternalEvidenceError); ok && externalError.Code != "" {
				code = externalError.Code
			}
			errorPath := artifactPath
			if code == pathInvalid {
				errorPath += "/path"
			} else if code == artifactDigest {
				errorPath += "/sha256"
			}
			if code == tooLarge || code == pathInvalid || code == artifactDigest {
				d.add(code, errorPath)
			} else {
				d.add(identityChanged, artifactPath)
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
	}
	if publication {
		if validatorArtifact == nil || reviewArtifact == nil {
			d.add(pathMismatch, path+"/artifacts")
		}
		if validatorArtifact != nil {
			data, present := verified[validatorArtifact.Path]
			if !present || !validatePlanValidatorReport(data) {
				d.add(schemaInvalid, path+"/artifacts/plan-validator-report.json")
			}
		}
		if reviewArtifact != nil {
			data, present := verified[reviewArtifact.Path]
			if !present || !validateIndependentPlanReview(data) {
				d.add(schemaInvalid, path+"/artifacts/independent-plan-review.md")
			}
		}
	}
}

const AcceptanceV2InventoryReportName = "evidence-inventory.json"

func parseExternalEvidenceInventoryReport(data []byte) (inventory, bool) {
	if len(data) == 0 || len(data) > maxV2Inventory || !utf8.Valid(data) || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) || scanV2Data(data) != nil {
		return inventory{}, false
	}
	var report externalInventoryReportJSON
	if !decodeStrict(data, &report) || report.Format != inventoryFmt || report.Version != inventoryVer || len(report.Entries) > externalRootMaxEntries {
		return inventory{}, false
	}
	inventory := inventory{Entries: report.Entries}
	if inventory.Entries == nil {
		inventory.Entries = []inventoryEntry{}
	}
	for index, entry := range inventory.Entries {
		if !validV2ArtifactPath(entry.Path) || (entry.Type != "file" && entry.Type != "directory") || entry.Bytes < 0 || entry.Bytes > maxV2Artifact || !validDefault(entry.Identity, maxV2Inventory) || !validV2Digest(entry.SHA256) || entry.Type == "directory" && (entry.Bytes != 0 || entry.SHA256 != DigestOutput(nil)) || index > 0 && inventory.Entries[index-1].Path >= entry.Path {
			return ExternalEvidenceInventory{}, false
		}
	}
	if !bytes.Equal(data, CanonicalExternalEvidenceInventoryReport(inventory)) {
		return ExternalEvidenceInventory{}, false
	}
	return inventory, true
}

func validateV2InventoryReport(root *evidenceRoot, matrix matrixV2, inventory inventory, d *v2Diagnostics) {
	if root == nil {
		return
	}
	seen := false
	eachV2Evidence(matrix, func(index int, field string, evidence *evidenceV2) {
		for artifactIndex, artifact := range evidence.Artifacts {
			if artifact.Name != AcceptanceV2InventoryReportName {
				continue
			}
			seen = true
			data, err := ReadVerifiedArtifact(root, artifact)
			if err == nil {
				reported, ok := parseExternalEvidenceInventoryReport(data)
				if !ok || !externalInventoryEqual(reported, inventory) {
					d.add(schemaInvalid, fmt.Sprintf("/rows/%d/%s/artifacts/%d", index, field, artifactIndex))
				}
			}
		}
	})
	if !seen {
		eachV2Evidence(matrix, func(_ int, _ string, _ *evidenceV2) {
			if !seen {
				d.add(pathMismatch, v2RootPath+"/inventory")
				seen = true
			}
		})
	}
}

func validateV2ClosedWorld(matrix matrixV2, inventory inventory, d *v2Diagnostics) {
	bad := func(path string) { d.add(pathMismatch, path) }
	referenced := map[string]artifactV2{}
	names, directories, reports := map[string]string{}, map[string]string{}, map[string]struct{}{}
	eachV2Evidence(matrix, func(_ int, _ string, evidence *evidenceV2) {
		for _, artifact := range evidence.Artifacts {
			pathKey, nameKey := externalIdentityKey(artifact.Path), externalIdentityKey(artifact.Name)
			if artifact.Name == AcceptanceV2InventoryReportName {
				if artifact.Path == AcceptanceV2InventoryReportName {
					reports[pathKey] = struct{}{}
				} else {
					bad(v2RootPath + "/inventory")
				}
				continue
			}
			if prior, exists := referenced[pathKey]; exists && (prior.Name != artifact.Name || prior.SHA256 != artifact.SHA256 || prior.Bytes != artifact.Bytes) {
				bad(v2RootPath)
			}
			if prior, exists := names[nameKey]; exists && prior != pathKey {
				bad(v2RootPath)
			}
			referenced[pathKey], names[nameKey] = artifact, pathKey
			parts := strings.Split(artifact.Path, "/")
			for index := 1; index < len(parts); index++ {
				ancestor := strings.Join(parts[:index], "/")
				key := externalIdentityKey(ancestor)
				if prior, exists := directories[key]; exists && prior != ancestor {
					bad(v2RootPath)
				} else {
					directories[key] = ancestor
				}
			}
		}
	})
	if len(referenced) == 0 && len(reports) == 0 {
		if len(inventory.Entries) != 0 {
			bad(v2RootPath)
		}
		return
	}
	if len(reports) != 1 {
		bad(v2RootPath + "/inventory")
	}
	files, actualDirectories := map[string]inventoryEntry{}, map[string]inventoryEntry{}
	for _, entry := range inventory.Entries {
		key := externalIdentityKey(entry.Path)
		switch entry.Type {
		case "file":
			if _, exists := files[key]; exists {
				bad(v2RootPath)
			}
			files[key] = entry
		case "directory":
			expected, required := directories[key]
			if !required || expected != entry.Path {
				bad(v2RootPath + "/" + entry.Path)
			}
			if _, exists := actualDirectories[key]; exists {
				bad(v2RootPath)
			}
			actualDirectories[key] = entry
		default:
			bad(v2RootPath + "/" + entry.Path)
		}
	}
	if len(files) != len(referenced) || len(actualDirectories) != len(directories) {
		bad(v2RootPath)
	}
	for key, artifact := range referenced {
		entry, exists := files[key]
		if !exists || entry.Path != artifact.Path || entry.Bytes != artifact.Bytes || entry.SHA256 != artifact.SHA256 {
			bad(v2RootPath)
		}
	}
	for key := range files {
		if _, exists := referenced[key]; !exists {
			bad(v2RootPath)
		}
	}
	for key := range actualDirectories {
		if _, exists := directories[key]; !exists {
			bad(v2RootPath)
		}
	}
}

func initialV2Result(request requestV2, matrixSHA string) resultV1 {
	factsDigest := request.FactsSHA256
	if !validV2Digest(factsDigest) {
		factsDigest = strings.Repeat("0", 64)
	}
	return resultV1{Format: resultFmt, Version: resultVer, Status: "invalid", Code: "usage_invalid", EvaluationScope: request.NormalizedFacts.EvaluationScope, FactsSHA256: factsDigest, MatrixSHA256: matrixSHA, Rows: []resultRowV1{}, Diagnostics: []diagnosticV1{}}
}

func inputV2(input any) (requestV2, bool) {
	var request requestV2
	switch value := input.(type) {
	case requestV2:
		return value, true
	case *requestV2:
		if value != nil {
			return *value, true
		}
	case []byte:
		parsed, err := DecodeAcceptanceV2Request(value)
		if err == nil {
			return parsed, true
		}
	}
	return request, false
}

func ValidateAcceptanceV2(input any) AcceptanceResultV1 {
	return ValidateAcceptanceV2WithExclusions(input, nil)
}

func ValidateAcceptanceV2WithExclusions(input any, exclusions []string) AcceptanceResultV1 {
	request, ok := inputV2(input)
	if !ok {
		return initialV2Result(request, strings.Repeat("0", 64))
	}
	return validateAcceptanceV2RequestWithExclusions(request, exclusions)
}

func schemaVersionFromBytes(data []byte, member string) (string, bool) {
	if len(data) == 0 || len(data) > maxAcceptanceJSONBytes || scanV2JSON(data, maxAcceptanceJSONBytes, 32, maxAcceptanceRows*1024) != nil {
		return "", false
	}
	root, ok := rawObject(data)
	if !ok {
		return "", false
	}
	var version string
	raw, ok := root[member]
	if !ok || json.Unmarshal(raw, &version) != nil || version == "" {
		return "", false
	}
	return version, true
}

func ClassifyAcceptanceVersionPair(matrixBytes, manifestBytes []byte) string {
	matrixVersion, matrixOK := schemaVersionFromBytes(matrixBytes, "schema_version")
	manifestVersion, manifestOK := schemaVersionFromBytes(manifestBytes, "schema_version")
	if matrixOK && manifestOK && matrixVersion == AcceptanceMatrixSchemaVersion && manifestVersion == AcceptanceManifestSchemaVersion {
		return "v1/v1"
	}
	if matrixOK && manifestOK && matrixVersion == mSchema && manifestVersion == mfSchema {
		return "v2/v2"
	}
	matrixKnown := matrixVersion == AcceptanceMatrixSchemaVersion || matrixVersion == mSchema
	manifestKnown := manifestVersion == AcceptanceManifestSchemaVersion || manifestVersion == mfSchema
	if matrixOK && manifestOK && matrixKnown && manifestKnown && matrixVersion != manifestVersion {
		return "version_pair_mixed"
	}
	return "version_pair_unsupported"
}

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

func versionPairV2(matrixBytes []byte, facts factsV1) string {
	root, ok := rawObject(matrixBytes)
	if !ok {
		return "version_pair_unsupported"
	}
	var matrixVersion, manifestVersion string
	_ = json.Unmarshal(root["schema_version"], &matrixVersion)
	_ = json.Unmarshal(root["manifest_schema_version"], &manifestVersion)
	matrixV1, matrixV2 := matrixVersion == AcceptanceMatrixSchemaVersion, matrixVersion == mSchema
	manifestV1, manifestV2 := manifestVersion == AcceptanceManifestSchemaVersion, manifestVersion == mfSchema
	factsV1, factsV2 := facts.ManifestSchemaVersion == AcceptanceManifestSchemaVersion, facts.ManifestSchemaVersion == mfSchema
	if matrixV2 && manifestV2 && factsV2 {
		return ""
	}
	if (matrixV1 && manifestV2) || (matrixV2 && manifestV1) || (matrixV2 && manifestV2 && factsV1) || (matrixV1 && manifestV1 && factsV2) {
		return "version_pair_mixed"
	}
	return "version_pair_unsupported"
}

func validateAcceptanceV2RequestWithExclusions(request requestV2, exclusions []string) resultV1 {
	matrixBytes, matrixErr := base64.StdEncoding.DecodeString(request.MatrixBase64)
	result := initialV2Result(request, digestBytes(matrixBytes))
	d := newV2Diagnostics()
	stop := func(matrix *matrixV2) resultV1 { return finishV2Result(result, request.NormalizedFacts, d, matrix) }
	if request.Format != requestFmt || request.Version != requestVer || request.ControllerTime == "" || request.EvidenceRoot == "" || !validV2Digest(request.FactsSHA256) {
		d.add("usage_invalid", "/request")
		return stop(nil)
	}
	factsDigest := normalizedFactsDigestV1(request.NormalizedFacts)
	if !validV2Digest(factsDigest) || request.FactsSHA256 != factsDigest {
		d.add("digest_mismatch", "/facts_sha256")
	}
	validateNormalizedFactsV1Shape(request.NormalizedFacts, d)
	if len(matrixBytes) > maxMatrixInput {
		d.add(tooLarge, "/matrix_base64")
		return stop(nil)
	}
	if matrixErr != nil {
		d.add(matrixErrCode(matrixErr), "/matrix_base64")
		return stop(nil)
	}
	if err := scanV2Data(matrixBytes); err != nil {
		d.add(matrixErrCode(err), "/matrix")
		return stop(nil)
	}
	if code := versionPairV2(matrixBytes, request.NormalizedFacts); code != "" {
		d.add(code, "/version_pair")
		return stop(nil)
	}
	matrix, code := decodeV2(matrixBytes)
	if code != "" {
		d.add(code, "/matrix")
		return stop(nil)
	}
	generated, rootOK := validateV2Root(matrix, request.NormalizedFacts, d)
	if matrix.EvaluationScope != request.NormalizedFacts.EvaluationScope {
		d.add(bindingMismatch, "/evaluation_scope")
	}
	validateV2Facts(matrix, request.NormalizedFacts, d)
	validateV2Rows(matrix, request.NormalizedFacts, d)
	validateV2EvidenceTimes(matrix, generated, d)
	controllerTime, timeOK := parseTimeV2(request.ControllerTime)
	if !timeOK {
		d.add("usage_invalid", "/controller_time")
	} else if generated.After(controllerTime.Add(maxV2Skew)) {
		d.add(schemaInvalid, "/generated_at")
	}
	first := d.firstCode()
	if !rootOK || first == schemaInvalid || first == "manifest_version_unsupported" || first != "valid" && v2Priority(first) < v2Priority(rootInvalid) {
		return stop(&matrix)
	}
	root, err := OpenExternalEvidenceRoot(request.EvidenceRoot, exclusions)
	if err != nil {
		d.add(rootInvalid, v2RootPath)
		return stop(&matrix)
	}
	inventoryBefore, inventoryErr := InventoryExternalEvidenceRoot(root)
	if inventoryErr != nil {
		addV2ExternalError(d, inventoryErr, v2RootPath)
		return stop(&matrix)
	}
	policy, policyOK := policyFromV2(request.Policy)
	validateV2PolicyAndArtifacts(matrix, policy, policyOK, root, d)
	validateV2InventoryReport(root, matrix, inventoryBefore, d)
	if !d.has(artifactDigest) && !d.has(identityChanged) && !d.has(pathInvalid) && !d.has("unsupported_class_policy") {
		validateV2ClosedWorld(matrix, inventoryBefore, d)
	}
	artifactTotal := int64(0)
	eachV2Evidence(matrix, func(_ int, _ string, evidence *evidenceV2) {
		for _, artifact := range evidence.Artifacts {
			artifactTotal += artifact.Bytes
		}
	})
	if artifactTotal > maxV2Total {
		d.add(tooLarge, "/rows")
	}
	inventoryAfter, inventoryErr := InventoryExternalEvidenceRoot(root)
	if inventoryErr != nil {
		addV2ExternalError(d, inventoryErr, v2RootPath)
	} else if !externalInventoryEqual(inventoryBefore, inventoryAfter) {
		d.add("source_mutated", v2RootPath)
	}
	if matrix.EvaluationScope == "implementation-delivery" {
		for _, row := range matrix.Rows {
			if row.Status == "blocked" {
				d.add("rows_blocked", "/rows")
				break
			}
		}
	}
	return stop(&matrix)
}

func matrixErrCode(err error) string {
	if err == errV2DuplicateKey {
		return "matrix_duplicate_key"
	}
	if err == errV2TrailingValue {
		return "matrix_noncanonical"
	}
	return "matrix_json_invalid"
}

func finishV2Result(result resultV1, facts factsV1, d *v2Diagnostics, matrix *matrixV2) resultV1 {
	result.EvaluationScope, result.Diagnostics, result.Code = facts.EvaluationScope, d.sorted(), d.firstCode()
	switch result.Code {
	case "valid":
		result.Status = "valid"
		if matrix != nil {
			if matrix.EvaluationScope == "plan-publication" {
				result.Code = "specified"
			} else if matrix.EvaluationScope == "implementation-delivery" {
				result.Code = "observed"
			}
		}
	case "rows_blocked", "unsupported_class_policy":
		result.Status = "blocked"
	default:
		result.Status = "invalid"
	}
	if matrix != nil {
		result.Rows = result.Rows[:0]
		for _, row := range matrix.Rows {
			status, code := "valid", "specified"
			if matrix.EvaluationScope == "implementation-delivery" {
				status, code = "valid", "observed"
				if row.Status == "blocked" {
					status, code = "blocked", "blocked"
				}
				if row.AcceptanceClass == "benchmark" || row.AcceptanceClass == "evidence" {
					status, code = "blocked", "unsupported_class_policy"
				}
			}
			if result.Status == "invalid" {
				status, code = "invalid", result.Code
			}
			result.Rows = append(result.Rows, resultRowV1{ID: row.ID, Status: status, Code: code})
		}
	}
	return result
}

type compatibilityManifest struct {
	AcceptanceManifest
	TicketRevision string `json:"ticket_revision"`
}

type ImplementationPlanManifestV2CompatibilityResult struct {
	Status           string              `json:"status"`
	Code             string              `json:"code"`
	DeliveryAdmitted bool                `json:"delivery_admitted"`
	PlanSHA256       string              `json:"plan_sha256"`
	ManifestSHA256   string              `json:"manifest_sha256"`
	Rows             []AcceptancePlanRow `json:"rows"`
}

func ParseImplementationPlanManifestV2Compatibility(planBytes, manifestBytes []byte) ImplementationPlanManifestV2CompatibilityResult {
	planDigest, manifestDigest := digestBytes(planBytes), digestBytes(manifestBytes)
	result := ImplementationPlanManifestV2CompatibilityResult{Status: "invalid", Code: "compatibility_tuple_invalid", PlanSHA256: planDigest, ManifestSHA256: manifestDigest, Rows: []AcceptancePlanRow{}}
	if len(planBytes) != 44524 || planDigest != "e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744" || len(manifestBytes) != 17392 || manifestDigest != "f11f7b638adfec563482163f91d299df00467a3909bb27458cc9da8c6025dabc" {
		return result
	}
	var manifest compatibilityManifest
	if scanV2Data(manifestBytes) != nil {
		return result
	}
	decoder := json.NewDecoder(bytes.NewReader(manifestBytes))
	if decoder.Decode(&manifest) != nil {
		return result
	}
	if manifest.SchemaVersion != mfSchema || manifest.TicketID != "AIDEV-187" || manifest.Repository != "Zkrausman/pi-sampler" || manifest.PlanPath != "docs/techPlans/AIDEV-187-implementation-plan.md" || manifest.PlanSHA256 != result.PlanSHA256 || manifest.BaseSHA != "3d858a0d4f8219f5ca1db13ad1de72e35ee09758" || manifest.TicketRevision != "08967f81071a97e0fa0adb2430906e04fd448413ad41546e6f0b19fa5d24f5d4" || len(manifest.Rows) != 12 {
		return result
	}
	result.Rows = append(result.Rows, manifest.Rows...)
	result.Status, result.Code = "valid", "compatibility_tuple_understood"
	return result
}

func ParseImplementationPlanManifestV2CompatibilityFile(planPath, manifestPath string) (ImplementationPlanManifestV2CompatibilityResult, error) {
	plan, err := os.ReadFile(planPath)
	if err != nil {
		return ImplementationPlanManifestV2CompatibilityResult{Status: "invalid", Code: "compatibility_tuple_invalid"}, err
	}
	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		return ImplementationPlanManifestV2CompatibilityResult{Status: "invalid", Code: "compatibility_tuple_invalid"}, err
	}
	return ParseImplementationPlanManifestV2Compatibility(plan, manifest), nil
}

type externalIdentity struct {
	Device, File, FileHigh, Links, Blocks               uint64
	Size                                                int64
	Mode, Type                                          uint32
	Modified                                            int64
	HasDevice, HasFile, HasFile128, HasLinks, HasBlocks bool
	Reparse                                             bool
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

func collectExternalEntries(next func() ([]os.FileInfo, error)) ([]os.FileInfo, error) {
	entries := make([]os.FileInfo, 0, externalRootMaxEntries)
	for {
		batch, err := next()
		if len(batch) > 0 {
			if len(entries)+len(batch) > externalRootMaxEntries {
				return nil, &ExternalEvidenceError{Code: tooLarge}
			}
			entries = append(entries, batch...)
		}
		if err == io.EOF {
			return entries, nil
		}
		if err != nil {
			return nil, &ExternalEvidenceError{Code: identityChanged, Err: err}
		}
	}
}

type ExternalEvidenceError struct {
	Code string
	Err  error
}

func (e *ExternalEvidenceError) Error() string { return e.Code }
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
		set := func(target *uint64, present *bool, names ...string) {
			if value, ok := read(names...); ok {
				*target = value
				if present != nil {
					*present = true
				}
			}
		}
		set(&identity.Device, &identity.HasDevice, "Dev", "VolumeSerialNumber")
		set(&identity.File, &identity.HasFile, "Ino", "FileIndex", "FileIndexLow")
		set(&identity.FileHigh, nil, "FileIndexHigh")
		set(&identity.Links, &identity.HasLinks, "Nlink", "NumberOfLinks")
		set(&identity.Blocks, &identity.HasBlocks, "Blocks")
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

func normalizeExternalArtifact(value any, extras []any) (artifactV2, bool) {
	switch artifact := value.(type) {
	case artifactV2:
		return artifact, true
	case *artifactV2:
		if artifact != nil {
			return *artifact, true
		}
	case string:
		result := artifactV2{Path: artifact}
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
	return artifactV2{}, false
}

func ExternalEvidenceInventorySHA256(inventory ExternalEvidenceInventory) string {
	return digestBytes(canonicalJSON(inventory))
}
