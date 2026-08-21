package deliveryevidence

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	AcceptanceManifestSchemaVersion = "acceptance-manifest/v1"
	AcceptanceMatrixSchemaVersion   = "acceptance-matrix/v1"
	BenchmarkEvidenceSchemaVersion  = "benchmark-evidence/v1"
	WaiverSchemaVersion             = "delivery-waiver/v1"
	WaiverTrustSchemaVersion        = "delivery-waiver-trust/v1"
	WaiverReplaySchemaVersion       = "delivery-waiver-replay/v1"
	LocalBenchmarkEvents            = 10_000_000
	CIRegressionEvents              = 10_000
	maxAcceptanceJSONBytes          = 4 * 1024 * 1024
	maxAcceptanceRows               = 128
	maxBenchmarkRSSBytes            = 1 << 40
	maxBenchmarkVariance            = float64(maxBenchmarkRSSBytes) * float64(maxBenchmarkRSSBytes)
	maxWaiverAge                    = 30 * 24 * time.Hour
	maxWaiverFutureSkew             = 5 * time.Minute
)

var (
	immutableSHARe = regexp.MustCompile(`^[a-f0-9]{40}(?:[a-f0-9]{24})?$`)
	acceptanceIDRe = regexp.MustCompile(`^A[0-9]{1,9}-T[0-9]{2,4}$`)
	planIDRe       = regexp.MustCompile(`\bA[0-9]{1,9}-T[0-9]{2,4}\b`)
	identifierRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	hex64Re        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	nonceRe        = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
	waiverIDRe     = regexp.MustCompile(`^waiver-[a-z0-9][a-z0-9-]{0,95}$`)
)

type AcceptanceManifest struct {
	SchemaVersion string              `json:"schema_version"`
	TicketID      string              `json:"ticket_id"`
	Repository    string              `json:"repository"`
	PlanPath      string              `json:"plan_path"`
	PlanSHA256    string              `json:"plan_sha256"`
	BaseSHA       string              `json:"base_sha"`
	Rows          []AcceptancePlanRow `json:"rows"`
}

type AcceptancePlanRow struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	AcceptanceClass string `json:"acceptance_class"`
	Requirement     string `json:"requirement"`
}

type AcceptanceMatrix struct {
	SchemaVersion     string                `json:"schema_version"`
	TicketID          string                `json:"ticket_id"`
	Repository        string                `json:"repository"`
	PlanSHA256        string                `json:"plan_sha256"`
	ManifestSHA256    string                `json:"manifest_sha256"`
	BaseSHA           string                `json:"base_sha"`
	HeadSHA           string                `json:"head_sha"`
	PullRequestNumber int                   `json:"pull_request_number"`
	GeneratedAt       string                `json:"generated_at"`
	Rows              []AcceptanceMatrixRow `json:"rows"`
}

type AcceptanceMatrixRow struct {
	ID       string             `json:"id"`
	Status   string             `json:"status"`
	Observed *ObservedEvidence  `json:"observed,omitempty"`
	Waiver   *DeliveryWaiver    `json:"waiver,omitempty"`
	Blocker  *AcceptanceBlocker `json:"blocker,omitempty"`
}

type ObservedEvidence struct {
	AcceptanceClass   string                `json:"acceptance_class"`
	Verifier          string                `json:"verifier"`
	Command           string                `json:"command"`
	ToolVersion       string                `json:"tool_version"`
	EnvironmentClass  string                `json:"environment_class"`
	ExitStatus        int                   `json:"exit_status"`
	StartedAt         string                `json:"started_at"`
	CompletedAt       string                `json:"completed_at"`
	Artifacts         []ArtifactDigest      `json:"artifacts"`
	BenchmarkEvidence *BenchmarkEvidenceRef `json:"benchmark_evidence,omitempty"`
}

type ArtifactDigest struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type BenchmarkEvidenceRef struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type AcceptanceBlocker struct {
	Reason    string `json:"reason"`
	BlockedBy string `json:"blocked_by,omitempty"`
}

type DeliveryWaiver struct {
	SchemaVersion string            `json:"schema_version"`
	WaiverID      string            `json:"waiver_id"`
	Issuer        string            `json:"issuer"`
	KeyID         string            `json:"key_id"`
	Repository    string            `json:"repository"`
	TicketID      string            `json:"ticket_id"`
	PullRequest   WaiverPullRequest `json:"pull_request"`
	RowID         string            `json:"row_id"`
	PlanSHA256    string            `json:"plan_sha256"`
	Rationale     string            `json:"rationale"`
	Issue         string            `json:"issue"`
	Nonce         string            `json:"nonce"`
	IssuedAt      string            `json:"issued_at"`
	ExpiresAt     string            `json:"expires_at"`
	RevocationRef string            `json:"revocation_ref"`
	Signature     string            `json:"signature"`
}

type WaiverPullRequest struct {
	Number  int    `json:"number"`
	BaseSHA string `json:"base_sha"`
	HeadSHA string `json:"head_sha"`
}

type TrustedWaiverConfig struct {
	SchemaVersion string             `json:"schema_version"`
	Keys          []TrustedWaiverKey `json:"keys"`
	RevokedRefs   []string           `json:"revoked_refs"`
}

type TrustedWaiverKey struct {
	KeyID     string `json:"key_id"`
	Issuer    string `json:"issuer"`
	Algorithm string `json:"algorithm"`
	PublicKey string `json:"public_key"`
	Revoked   bool   `json:"revoked"`
}

type WaiverReplayState struct {
	SchemaVersion string              `json:"schema_version"`
	Consumed      []WaiverReplayEntry `json:"consumed"`
}

type WaiverReplayEntry struct {
	Nonce      string `json:"nonce"`
	WaiverID   string `json:"waiver_id"`
	ConsumedAt string `json:"consumed_at"`
}

type BenchmarkEvidence struct {
	SchemaVersion  string               `json:"schema_version"`
	TicketID       string               `json:"ticket_id"`
	Repository     string               `json:"repository"`
	BaseSHA        string               `json:"base_sha"`
	HeadSHA        string               `json:"head_sha"`
	Class          string               `json:"class"`
	WorkloadDigest string               `json:"workload_digest"`
	EventCount     int64                `json:"event_count"`
	WarmupEvents   int64                `json:"warmup_events"`
	Repetitions    int                  `json:"repetitions"`
	TimeoutMS      int64                `json:"timeout_ms"`
	StartedAt      string               `json:"started_at"`
	CompletedAt    string               `json:"completed_at"`
	EventComplete  bool                 `json:"event_complete"`
	SlopeEstimator string               `json:"slope_estimator"`
	Runs           []BenchmarkRun       `json:"runs"`
	Summary        BenchmarkSummary     `json:"summary"`
	Environment    BenchmarkEnvironment `json:"environment"`
	Thresholds     *BenchmarkThresholds `json:"thresholds,omitempty"`
	Outcome        string               `json:"outcome"`
}

type BenchmarkRun struct {
	Repetition         int         `json:"repetition"`
	EventCount         int64       `json:"event_count"`
	CompletedEvents    int64       `json:"completed_events"`
	DurationMS         float64     `json:"duration_ms"`
	PeakRSSBytes       int64       `json:"peak_rss_bytes"`
	RSSSamples         []RSSSample `json:"rss_samples"`
	SlopeBytesPerEvent float64     `json:"slope_bytes_per_event"`
	Variance           float64     `json:"variance"`
}

type RSSSample struct {
	Events   int64 `json:"events"`
	RSSBytes int64 `json:"rss_bytes"`
}

type BenchmarkSummary struct {
	DurationMS         float64 `json:"duration_ms"`
	PeakRSSBytes       int64   `json:"peak_rss_bytes"`
	SlopeBytesPerEvent float64 `json:"slope_bytes_per_event"`
	Variance           float64 `json:"variance"`
	CompletedEvents    int64   `json:"completed_events"`
}

type BenchmarkEnvironment struct {
	Runtime       string `json:"runtime"`
	HardwareClass string `json:"hardware_class"`
	CPUCount      int    `json:"cpu_count"`
	MemoryBytes   int64  `json:"memory_bytes"`
}

type BenchmarkThresholds struct {
	MaxDurationMS         float64 `json:"max_duration_ms"`
	MaxPeakRSSBytes       int64   `json:"max_peak_rss_bytes"`
	MaxSlopeBytesPerEvent float64 `json:"max_slope_bytes_per_event"`
	MaxVariance           float64 `json:"max_variance"`
}

// jsonBudget rejects deep or enormous JSON before the typed decoder allocates
// an unbounded object graph. DisallowUnknownFields below supplies the schema
// boundary; this pass additionally rejects duplicate object keys.
type jsonBudget struct {
	values int
}

func decodeStrictJSON(data []byte, target any) error {
	if len(data) == 0 || len(data) > maxAcceptanceJSONBytes {
		return fmt.Errorf("JSON payload exceeds the bounded delivery-evidence limit")
	}
	budget := &jsonBudget{}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanJSONValue(decoder, 0, budget); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return fmt.Errorf("JSON payload contains trailing data")
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode strict JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("JSON payload contains more than one value")
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder, depth int, budget *jsonBudget) error {
	if depth > 32 {
		return fmt.Errorf("JSON nesting exceeds the delivery-evidence limit")
	}
	budget.values++
	if budget.values > 100_000 {
		return fmt.Errorf("JSON value count exceeds the delivery-evidence limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("scan JSON: %w", err)
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("scan JSON object key: %w", err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("JSON object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder, depth+1, budget); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return fmt.Errorf("JSON object is not closed")
		}
	case '[':
		items := 0
		for decoder.More() {
			items++
			if items > maxAcceptanceRows*1024 {
				return fmt.Errorf("JSON array exceeds the delivery-evidence limit")
			}
			if err := scanJSONValue(decoder, depth+1, budget); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return fmt.Errorf("JSON array is not closed")
		}
	}
	return nil
}

func validateAcceptanceSHA(value, label string) error {
	if !immutableSHARe.MatchString(value) {
		return fmt.Errorf("%s must be a lowercase immutable commit SHA", label)
	}
	return nil
}

func validateDigest(value, label string) error {
	if !hex64Re.MatchString(value) {
		return fmt.Errorf("%s must be a lowercase SHA-256 digest", label)
	}
	return nil
}

func validateRelativePath(value, label string) error {
	if value == "" || filepath.IsAbs(value) || strings.Contains(value, "\\") || strings.ContainsRune(value, 0) || strings.Contains(value, "//") {
		return fmt.Errorf("%s must be a repository-relative path", label)
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%s contains an unsafe path segment", label)
		}
	}
	return nil
}

func pathInside(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func containedRegularFile(root, relativePath, label string) (string, error) {
	if err := validateRelativePath(relativePath, label); err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve repository root: %w", err)
	}
	rootReal, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return "", fmt.Errorf("resolve repository root: %w", err)
	}
	candidateAbs, err := filepath.Abs(filepath.Join(rootAbs, filepath.FromSlash(relativePath)))
	if err != nil || !pathInside(rootAbs, candidateAbs) {
		return "", fmt.Errorf("%s escapes repository root", label)
	}
	info, err := os.Lstat(candidateAbs)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", label, err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s is not a regular file", label)
	}
	candidateReal, err := filepath.EvalSymlinks(candidateAbs)
	if err != nil || !pathInside(rootReal, candidateReal) {
		return "", fmt.Errorf("%s escapes repository root", label)
	}
	return candidateReal, nil
}

func externalPath(path, repositoryRoot, label string, mustExist bool) (string, error) {
	if path == "" || strings.ContainsRune(path, 0) {
		return "", fmt.Errorf("%s is required", label)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", label, err)
	}
	if repositoryRoot != "" {
		root, rootErr := filepath.Abs(repositoryRoot)
		if rootErr == nil {
			rootReal, evalErr := filepath.EvalSymlinks(root)
			if evalErr == nil {
				candidateForCheck := absolute
				if real, evalErr := filepath.EvalSymlinks(absolute); evalErr == nil {
					candidateForCheck = real
				}
				if pathInside(rootReal, candidateForCheck) {
					return "", fmt.Errorf("%s must be consumer-owned and outside the candidate repository", label)
				}
			}
		}
	}
	info, statErr := os.Lstat(absolute)
	if statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return "", fmt.Errorf("%s is not a regular file", label)
		}
		return absolute, nil
	}
	if !mustExist && os.IsNotExist(statErr) {
		parent := filepath.Dir(absolute)
		if _, err := filepath.EvalSymlinks(parent); err != nil {
			return "", fmt.Errorf("resolve %s parent: %w", label, err)
		}
		return absolute, nil
	}
	return "", fmt.Errorf("read %s: %w", label, statErr)
}

func boundedRead(path, label string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", label, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > max {
		return nil, fmt.Errorf("%s exceeds its bounded regular-file contract", label)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", label, err)
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%s exceeds its bounded size", label)
	}
	return data, nil
}

func fileSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// canonicalPlanSHA256 hashes the plan's specified canonical newline form. Git
// stores the plan with LF bytes, while a Windows checkout may materialize CRLF;
// normalizing both CRLF and lone CR to LF keeps the manifest digest immutable
// across checkout settings without trusting working-tree line endings.
func canonicalPlanSHA256(data []byte) string {
	canonical := bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	canonical = bytes.ReplaceAll(canonical, []byte("\r"), []byte("\n"))
	return fileSHA256(canonical)
}

func validateAcceptanceClass(value string) bool {
	switch value {
	case "ordinary", "authority", "waiver", "requirement", "benchmark-local-10m", "benchmark-ci-regression", "resource-bounded", "concurrency":
		return true
	default:
		return false
	}
}

func validateTicketID(value string) error {
	if !ticketID.MatchString(value) {
		return fmt.Errorf("invalid ticket_id %q", value)
	}
	return nil
}

func expectedPlanPrefix(ticket string) string {
	parts := strings.Split(ticket, "-")
	if len(parts) == 2 {
		return "A" + parts[1]
	}
	return ""
}

func validateAcceptanceManifest(manifest AcceptanceManifest, repositoryRoot, expectedRepository, expectedBase string) (string, map[string]AcceptancePlanRow, error) {
	if manifest.SchemaVersion != AcceptanceManifestSchemaVersion {
		return "", nil, fmt.Errorf("unsupported acceptance manifest schema_version %q", manifest.SchemaVersion)
	}
	if err := validateTicketID(manifest.TicketID); err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(manifest.Repository) == "" || (expectedRepository != "" && manifest.Repository != expectedRepository) {
		return "", nil, fmt.Errorf("acceptance manifest repository binding is invalid")
	}
	if err := validateDigest(manifest.PlanSHA256, "plan_sha256"); err != nil {
		return "", nil, err
	}
	if err := validateAcceptanceSHA(manifest.BaseSHA, "base_sha"); err != nil {
		return "", nil, err
	}
	if expectedBase != "" && manifest.BaseSHA != expectedBase {
		return "", nil, fmt.Errorf("acceptance manifest base_sha does not match the selected immutable base")
	}
	planPath, err := containedRegularFile(repositoryRoot, manifest.PlanPath, "plan_path")
	if err != nil {
		return "", nil, err
	}
	planBytes, err := boundedRead(planPath, "implementation plan", 2*1024*1024)
	if err != nil {
		return "", nil, err
	}
	if got := canonicalPlanSHA256(planBytes); got != manifest.PlanSHA256 {
		return "", nil, fmt.Errorf("plan_sha256 does not match the canonical implementation plan bytes")
	}
	if len(manifest.Rows) == 0 || len(manifest.Rows) > maxAcceptanceRows {
		return "", nil, fmt.Errorf("acceptance manifest rows are outside their bound")
	}
	rows := make(map[string]AcceptancePlanRow, len(manifest.Rows))
	prefix := expectedPlanPrefix(manifest.TicketID)
	for _, row := range manifest.Rows {
		if !acceptanceIDRe.MatchString(row.ID) || (prefix != "" && !strings.HasPrefix(row.ID, prefix+"-T")) {
			return "", nil, fmt.Errorf("invalid or cross-ticket acceptance ID %q", row.ID)
		}
		if strings.TrimSpace(row.Title) == "" || strings.TrimSpace(row.Requirement) == "" || len(row.Title) > 240 || len(row.Requirement) > 4096 || !validateAcceptanceClass(row.AcceptanceClass) {
			return "", nil, fmt.Errorf("acceptance row %q is invalid", row.ID)
		}
		if _, exists := rows[row.ID]; exists {
			return "", nil, fmt.Errorf("duplicate acceptance ID %q", row.ID)
		}
		rows[row.ID] = row
	}
	planIDs := map[string]int{}
	for _, id := range planIDRe.FindAllString(string(planBytes), -1) {
		planIDs[id]++
	}
	if len(planIDs) != len(rows) {
		return "", nil, fmt.Errorf("acceptance manifest does not cover exactly the plan's stable acceptance IDs")
	}
	for id, count := range planIDs {
		if count != 1 {
			return "", nil, fmt.Errorf("plan acceptance ID %q is duplicated or missing its unique definition", id)
		}
		if _, exists := rows[id]; !exists {
			return "", nil, fmt.Errorf("plan acceptance ID %q is absent from the manifest", id)
		}
	}
	return planPath, rows, nil
}

// ValidateAcceptanceManifestFile validates the strict manifest and binds it to
// the plan bytes in repositoryRoot. expectedRepository and expectedBase may be
// empty for structural-only callers, but production validation supplies both.
func ValidateAcceptanceManifestFile(path, repositoryRoot, expectedRepository, expectedBase string) error {
	data, err := boundedRead(path, "acceptance manifest", maxAcceptanceJSONBytes)
	if err != nil {
		return err
	}
	if err := validatePublishedSchema(repositoryRoot, "acceptance-manifest-v1.schema.json", data, "acceptance manifest"); err != nil {
		return err
	}
	var manifest AcceptanceManifest
	if err := decodeStrictJSON(data, &manifest); err != nil {
		return err
	}
	_, _, err = validateAcceptanceManifest(manifest, repositoryRoot, expectedRepository, expectedBase)
	return err
}

func parseTime(value, label string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be an RFC3339 timestamp", label)
	}
	return parsed.UTC(), nil
}

func closeEnough(left, right float64) bool {
	return math.Abs(left-right) <= math.Max(1e-9, math.Max(math.Abs(left), math.Abs(right))*1e-6)
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	copyValues := append([]float64(nil), values...)
	sort.Float64s(copyValues)
	middle := len(copyValues) / 2
	if len(copyValues)%2 == 1 {
		return copyValues[middle]
	}
	return (copyValues[middle-1] + copyValues[middle]) / 2
}

func variance(values []float64) float64 {
	if len(values) < 2 {
		return 0
	}
	mean := 0.0
	for _, value := range values {
		mean += value
	}
	mean /= float64(len(values))
	result := 0.0
	for _, value := range values {
		delta := value - mean
		result += delta * delta
	}
	return result / float64(len(values))
}

func theilSenSlope(samples []RSSSample) (float64, error) {
	if len(samples) < 2 {
		return 0, fmt.Errorf("benchmark requires at least two RSS samples")
	}
	slopes := make([]float64, 0, len(samples)*(len(samples)-1)/2)
	for left := 0; left < len(samples); left++ {
		for right := left + 1; right < len(samples); right++ {
			deltaEvents := samples[right].Events - samples[left].Events
			if deltaEvents <= 0 {
				return 0, fmt.Errorf("benchmark RSS sample events must be strictly increasing")
			}
			slope := float64(samples[right].RSSBytes-samples[left].RSSBytes) / float64(deltaEvents)
			if math.IsNaN(slope) || math.IsInf(slope, 0) {
				return 0, fmt.Errorf("benchmark RSS slope is not finite")
			}
			slopes = append(slopes, slope)
		}
	}
	return median(slopes), nil
}

func validateBenchmarkEvidence(evidence BenchmarkEvidence, expectedRepository, expectedBase, expectedHead, expectedClass string, now time.Time) error {
	if evidence.SchemaVersion != BenchmarkEvidenceSchemaVersion {
		return fmt.Errorf("unsupported benchmark evidence schema_version %q", evidence.SchemaVersion)
	}
	if err := validateTicketID(evidence.TicketID); err != nil {
		return err
	}
	if evidence.Repository == "" || (expectedRepository != "" && evidence.Repository != expectedRepository) {
		return fmt.Errorf("benchmark repository binding is invalid")
	}
	if err := validateAcceptanceSHA(evidence.BaseSHA, "benchmark base_sha"); err != nil {
		return err
	}
	if err := validateAcceptanceSHA(evidence.HeadSHA, "benchmark head_sha"); err != nil {
		return err
	}
	if expectedBase != "" && evidence.BaseSHA != expectedBase || expectedHead != "" && evidence.HeadSHA != expectedHead {
		return fmt.Errorf("benchmark immutable Git binding does not match the candidate")
	}
	if evidence.Class != "local-10m" && evidence.Class != "ci-regression" {
		return fmt.Errorf("unknown benchmark class %q", evidence.Class)
	}
	if expectedClass != "" && evidence.Class != expectedClass {
		return fmt.Errorf("benchmark class does not match its acceptance row")
	}
	if evidence.Class == "local-10m" && evidence.EventCount != LocalBenchmarkEvents {
		return fmt.Errorf("local benchmark must process exactly 10,000,000 events")
	}
	if evidence.Class == "ci-regression" && evidence.EventCount != CIRegressionEvents {
		return fmt.Errorf("CI benchmark must process the configured fixed regression event count")
	}
	if evidence.EventCount < 1 || evidence.EventCount > LocalBenchmarkEvents || evidence.WarmupEvents < 0 || evidence.WarmupEvents > 1_000_000 || evidence.WarmupEvents > evidence.EventCount || evidence.Repetitions < 1 || evidence.Repetitions > 32 || evidence.TimeoutMS < 1000 || evidence.TimeoutMS > 1_800_000 || !hex64Re.MatchString(evidence.WorkloadDigest) {
		return fmt.Errorf("benchmark configuration is outside its fixed bounds")
	}
	started, err := parseTime(evidence.StartedAt, "benchmark started_at")
	if err != nil {
		return err
	}
	completed, err := parseTime(evidence.CompletedAt, "benchmark completed_at")
	if err != nil {
		return err
	}
	if completed.Before(started) || completed.After(now.Add(maxWaiverFutureSkew)) {
		return fmt.Errorf("benchmark timestamps are not chronological and current")
	}
	if !evidence.EventComplete || len(evidence.Runs) != evidence.Repetitions || len(evidence.Runs) == 0 {
		return fmt.Errorf("benchmark event completeness or repetition coverage is false")
	}
	if evidence.SlopeEstimator != "theil-sen" {
		return fmt.Errorf("benchmark must declare the robust theil-sen slope estimator")
	}
	if evidence.Environment.Runtime == "" || !identifierRe.MatchString(evidence.Environment.HardwareClass) || evidence.Environment.CPUCount < 1 || evidence.Environment.CPUCount > 1024 || evidence.Environment.MemoryBytes < 1 || evidence.Environment.MemoryBytes > maxBenchmarkRSSBytes {
		return fmt.Errorf("benchmark runtime or hardware classification is invalid")
	}
	if evidence.Outcome != "baseline" && evidence.Outcome != "passed" && evidence.Outcome != "failed" {
		return fmt.Errorf("invalid benchmark outcome %q", evidence.Outcome)
	}
	if evidence.Outcome == "passed" {
		return fmt.Errorf("benchmark pass claims are disabled until separately reviewed external threshold approval is bound")
	}
	if evidence.Thresholds != nil {
		return fmt.Errorf("benchmark thresholds require separately reviewed external approval; candidate-authored thresholds are not accepted")
	}

	durations := make([]float64, 0, len(evidence.Runs))
	runSlopes := make([]float64, 0, len(evidence.Runs))
	peakRSS := int64(0)
	for index, run := range evidence.Runs {
		if run.Repetition != index+1 || run.EventCount != evidence.EventCount || run.CompletedEvents != evidence.EventCount || run.DurationMS <= 0 || run.DurationMS > float64(evidence.TimeoutMS) || run.PeakRSSBytes < 1 || run.PeakRSSBytes > maxBenchmarkRSSBytes || len(run.RSSSamples) < 2 || len(run.RSSSamples) > 1024 {
			return fmt.Errorf("benchmark repetition %d is incomplete or outside its bounds", index+1)
		}
		if run.PeakRSSBytes > peakRSS {
			peakRSS = run.PeakRSSBytes
		}
		sampleRSS := make([]float64, 0, len(run.RSSSamples))
		lastEvents := int64(-1)
		for _, sample := range run.RSSSamples {
			if sample.Events < 0 || sample.Events > evidence.EventCount || sample.Events <= lastEvents || sample.RSSBytes < 1 || sample.RSSBytes > maxBenchmarkRSSBytes {
				return fmt.Errorf("benchmark repetition %d contains malformed RSS samples", index+1)
			}
			lastEvents = sample.Events
			sampleRSS = append(sampleRSS, float64(sample.RSSBytes))
		}
		if run.RSSSamples[0].Events != 0 || run.RSSSamples[len(run.RSSSamples)-1].Events != evidence.EventCount {
			return fmt.Errorf("benchmark repetition %d does not cover the complete event range", index+1)
		}
		slope, err := theilSenSlope(run.RSSSamples)
		if err != nil || !closeEnough(slope, run.SlopeBytesPerEvent) {
			return fmt.Errorf("benchmark repetition %d has a non-reproducible robust slope", index+1)
		}
		runVariance := variance(sampleRSS)
		if run.Variance < 0 || run.Variance > maxBenchmarkVariance || math.IsNaN(run.Variance) || math.IsInf(run.Variance, 0) || !closeEnough(runVariance, run.Variance) {
			return fmt.Errorf("benchmark repetition %d has a non-reproducible variance", index+1)
		}
		durations = append(durations, run.DurationMS)
		runSlopes = append(runSlopes, run.SlopeBytesPerEvent)
	}
	if evidence.Summary.CompletedEvents != evidence.EventCount || evidence.Summary.PeakRSSBytes != peakRSS || evidence.Summary.DurationMS <= 0 || evidence.Summary.DurationMS > float64(evidence.TimeoutMS) || evidence.Summary.Variance < 0 || evidence.Summary.Variance > maxBenchmarkVariance || !closeEnough(evidence.Summary.DurationMS, median(durations)) || !closeEnough(evidence.Summary.SlopeBytesPerEvent, median(runSlopes)) || !closeEnough(evidence.Summary.Variance, variance(durations)) {
		return fmt.Errorf("benchmark summary does not match the repetitions")
	}
	return nil
}

// ValidateBenchmarkEvidenceAt validates a benchmark without consuming any
// authority. It deliberately accepts a baseline as a measurement, never as a
// pass claim.
func ValidateBenchmarkEvidenceAt(evidence BenchmarkEvidence, expectedRepository, expectedBase, expectedHead, expectedClass string, now time.Time) error {
	return validateBenchmarkEvidence(evidence, expectedRepository, expectedBase, expectedHead, expectedClass, now.UTC())
}

func ValidateBenchmarkEvidenceFile(path, expectedRepository, expectedBase, expectedHead, expectedClass string) error {
	return ValidateBenchmarkEvidenceFileAt(path, "", expectedRepository, expectedBase, expectedHead, expectedClass)
}

// ValidateBenchmarkEvidenceFileAt validates a benchmark file against the
// published Draft 2020-12 contract before applying semantic and Git bindings.
func ValidateBenchmarkEvidenceFileAt(path, repositoryRoot, expectedRepository, expectedBase, expectedHead, expectedClass string) error {
	data, err := boundedRead(path, "benchmark evidence", maxAcceptanceJSONBytes)
	if err != nil {
		return err
	}
	if err := validatePublishedSchema(repositoryRoot, "benchmark-evidence-v1.schema.json", data, "benchmark evidence"); err != nil {
		return err
	}
	var evidence BenchmarkEvidence
	if err := decodeStrictJSON(data, &evidence); err != nil {
		return err
	}
	return ValidateBenchmarkEvidenceAt(evidence, expectedRepository, expectedBase, expectedHead, expectedClass, time.Now().UTC())
}

func canonicalWaiverBytes(waiver DeliveryWaiver) ([]byte, error) {
	payload := map[string]any{
		"expires_at":     waiver.ExpiresAt,
		"issued_at":      waiver.IssuedAt,
		"issuer":         waiver.Issuer,
		"issue":          waiver.Issue,
		"key_id":         waiver.KeyID,
		"nonce":          waiver.Nonce,
		"plan_sha256":    waiver.PlanSHA256,
		"pull_request":   map[string]any{"base_sha": waiver.PullRequest.BaseSHA, "head_sha": waiver.PullRequest.HeadSHA, "number": waiver.PullRequest.Number},
		"rationale":      waiver.Rationale,
		"repository":     waiver.Repository,
		"revocation_ref": waiver.RevocationRef,
		"row_id":         waiver.RowID,
		"schema_version": waiver.SchemaVersion,
		"ticket_id":      waiver.TicketID,
		"waiver_id":      waiver.WaiverID,
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "")
	if err := encoder.Encode(payload); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func parseEd25519PublicKey(value string) (ed25519.PublicKey, error) {
	if block, _ := pem.Decode([]byte(value)); block != nil {
		key, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse trusted public key: %w", err)
		}
		publicKey, ok := key.(ed25519.PublicKey)
		if !ok {
			return nil, fmt.Errorf("trusted public key is not Ed25519")
		}
		return publicKey, nil
	}
	der, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("decode trusted public key")
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse trusted public key: %w", err)
	}
	publicKey, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("trusted public key is not Ed25519")
	}
	return publicKey, nil
}

func validateTrustedConfig(config TrustedWaiverConfig) (map[string]TrustedWaiverKey, error) {
	if config.SchemaVersion != WaiverTrustSchemaVersion || len(config.Keys) == 0 || len(config.Keys) > 32 {
		return nil, fmt.Errorf("trusted waiver configuration is missing or unsupported")
	}
	keys := make(map[string]TrustedWaiverKey, len(config.Keys))
	for _, key := range config.Keys {
		if !identifierRe.MatchString(key.KeyID) || strings.TrimSpace(key.Issuer) == "" || key.Algorithm != "ed25519" || strings.TrimSpace(key.PublicKey) == "" {
			return nil, fmt.Errorf("trusted waiver key is invalid")
		}
		if _, exists := keys[key.KeyID]; exists {
			return nil, fmt.Errorf("trusted waiver key ID is duplicated")
		}
		if _, err := parseEd25519PublicKey(key.PublicKey); err != nil {
			return nil, err
		}
		keys[key.KeyID] = key
	}
	seenRevocations := map[string]struct{}{}
	for _, ref := range config.RevokedRefs {
		if !identifierRe.MatchString(ref) {
			return nil, fmt.Errorf("trusted waiver revocation reference is invalid")
		}
		if _, exists := seenRevocations[ref]; exists {
			return nil, fmt.Errorf("trusted waiver revocation reference is duplicated")
		}
		seenRevocations[ref] = struct{}{}
	}
	return keys, nil
}

func loadTrustedWaiverConfig(path, repositoryRoot string) (TrustedWaiverConfig, map[string]TrustedWaiverKey, error) {
	configPath, err := externalPath(path, repositoryRoot, "trusted waiver configuration", true)
	if err != nil {
		return TrustedWaiverConfig{}, nil, err
	}
	data, err := boundedRead(configPath, "trusted waiver configuration", 256*1024)
	if err != nil {
		return TrustedWaiverConfig{}, nil, err
	}
	var config TrustedWaiverConfig
	if err := decodeStrictJSON(data, &config); err != nil {
		return TrustedWaiverConfig{}, nil, err
	}
	keys, err := validateTrustedConfig(config)
	return config, keys, err
}

func validateWaiver(waiver DeliveryWaiver, config TrustedWaiverConfig, keys map[string]TrustedWaiverKey, expectedRepository, expectedTicket, expectedRow, expectedPlan, expectedBase, expectedHead string, expectedPR int, now time.Time) error {
	if waiver.SchemaVersion != WaiverSchemaVersion || !waiverIDRe.MatchString(waiver.WaiverID) || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@:/ -]{0,127}$`).MatchString(waiver.Issuer) || !identifierRe.MatchString(waiver.KeyID) || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`).MatchString(waiver.Repository) || !nonceRe.MatchString(waiver.Nonce) || len(waiver.Rationale) < 1 || len(waiver.Rationale) > 4096 || !ticketID.MatchString(waiver.Issue) || !acceptanceIDRe.MatchString(waiver.RowID) || !hex64Re.MatchString(waiver.PlanSHA256) || !identifierRe.MatchString(waiver.RevocationRef) || waiver.Signature == "" {
		return fmt.Errorf("delivery waiver fields are invalid")
	}
	if expectedRepository != "" && waiver.Repository != expectedRepository || expectedTicket != "" && waiver.TicketID != expectedTicket || expectedRow != "" && waiver.RowID != expectedRow || expectedPlan != "" && waiver.PlanSHA256 != expectedPlan {
		return fmt.Errorf("delivery waiver is bound to the wrong repository, ticket, row, or plan")
	}
	if err := validateTicketID(waiver.TicketID); err != nil {
		return err
	}
	if err := validateAcceptanceSHA(waiver.PullRequest.BaseSHA, "waiver pull request base_sha"); err != nil {
		return err
	}
	if err := validateAcceptanceSHA(waiver.PullRequest.HeadSHA, "waiver pull request head_sha"); err != nil {
		return err
	}
	if waiver.PullRequest.Number < 1 || waiver.PullRequest.Number > 1_000_000_000 {
		return fmt.Errorf("waiver pull request number is invalid")
	}
	if expectedPR > 0 && waiver.PullRequest.Number != expectedPR || expectedBase != "" && waiver.PullRequest.BaseSHA != expectedBase || expectedHead != "" && waiver.PullRequest.HeadSHA != expectedHead {
		return fmt.Errorf("delivery waiver is bound to the wrong pull request or immutable Git range")
	}
	issued, err := parseTime(waiver.IssuedAt, "waiver issued_at")
	if err != nil {
		return err
	}
	expires, err := parseTime(waiver.ExpiresAt, "waiver expires_at")
	if err != nil {
		return err
	}
	if issued.After(expires) || issued.After(now.Add(maxWaiverFutureSkew)) || !expires.After(now) || expires.Sub(issued) > maxWaiverAge {
		return fmt.Errorf("delivery waiver is expired, future-dated, or too long-lived")
	}
	key, ok := keys[waiver.KeyID]
	if !ok || key.Revoked || key.Issuer != waiver.Issuer {
		return fmt.Errorf("delivery waiver issuer or key is not trusted")
	}
	for _, ref := range config.RevokedRefs {
		if ref == waiver.RevocationRef {
			return fmt.Errorf("delivery waiver revocation reference is revoked")
		}
	}
	if len(waiver.Signature) < ed25519.SignatureSize || len(waiver.Signature) > 128 {
		return fmt.Errorf("delivery waiver signature is outside its bound")
	}
	signature, err := base64.RawURLEncoding.DecodeString(waiver.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("delivery waiver signature is not canonical base64url")
	}
	publicKey, err := parseEd25519PublicKey(key.PublicKey)
	if err != nil {
		return err
	}
	payload, err := canonicalWaiverBytes(waiver)
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return fmt.Errorf("delivery waiver signature verification failed")
	}
	return nil
}

func replayStateTarget(path, repositoryRoot string) (string, error) {
	return externalPath(path, repositoryRoot, "waiver replay state", false)
}

func consumeWaiverNonces(path, repositoryRoot string, waivers []DeliveryWaiver, now time.Time) error {
	if len(waivers) == 0 {
		return nil
	}
	target, err := replayStateTarget(path, repositoryRoot)
	if err != nil {
		return err
	}
	lockPath := target + ".lock"
	if info, statErr := os.Lstat(lockPath); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("waiver replay lock is unsafe")
	}
	lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("waiver replay state is busy or unavailable")
	}
	lock.Close()
	defer os.Remove(lockPath)

	state := WaiverReplayState{SchemaVersion: WaiverReplaySchemaVersion, Consumed: []WaiverReplayEntry{}}
	if data, readErr := os.ReadFile(target); readErr == nil {
		if err := decodeStrictJSON(data, &state); err != nil {
			return err
		}
	} else if !os.IsNotExist(readErr) {
		return fmt.Errorf("read waiver replay state: %w", readErr)
	}
	if state.SchemaVersion != WaiverReplaySchemaVersion || len(state.Consumed) > 10_000 {
		return fmt.Errorf("waiver replay state is invalid or exceeds its bound")
	}
	seen := make(map[string]struct{}, len(state.Consumed)+len(waivers))
	for _, entry := range state.Consumed {
		if !nonceRe.MatchString(entry.Nonce) || !waiverIDRe.MatchString(entry.WaiverID) {
			return fmt.Errorf("waiver replay state contains an invalid entry")
		}
		if _, exists := seen[entry.Nonce]; exists {
			return fmt.Errorf("waiver replay state contains a duplicate nonce")
		}
		seen[entry.Nonce] = struct{}{}
	}
	for _, waiver := range waivers {
		if _, exists := seen[waiver.Nonce]; exists {
			return fmt.Errorf("delivery waiver nonce has already been consumed")
		}
		seen[waiver.Nonce] = struct{}{}
		state.Consumed = append(state.Consumed, WaiverReplayEntry{Nonce: waiver.Nonce, WaiverID: waiver.WaiverID, ConsumedAt: now.UTC().Format(time.RFC3339Nano)})
	}
	if len(state.Consumed) > 10_000 {
		return fmt.Errorf("waiver replay state exceeds its bound")
	}
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode waiver replay state: %w", err)
	}
	tmp := fmt.Sprintf("%s.tmp-%d", target, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write waiver replay state: %w", err)
	}
	if _, statErr := os.Stat(target); os.IsNotExist(statErr) {
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("publish waiver replay state atomically: %w", err)
		}
		return nil
	} else if statErr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("inspect waiver replay state before publish: %w", statErr)
	}
	// Windows does not replace an existing destination with os.Rename. The
	// exclusive lock above still makes this bounded update single-writer; the
	// destination was checked as a regular non-symlink file before this write.
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("publish waiver replay state: %w", err)
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	_ = os.Remove(tmp)
	if writeErr != nil {
		return fmt.Errorf("publish waiver replay state: %w", writeErr)
	}
	if syncErr != nil {
		return fmt.Errorf("sync waiver replay state: %w", syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close waiver replay state: %w", closeErr)
	}
	return nil
}

// ValidateWaiverFile verifies a consumer-owned signature and atomically consumes
// its nonce. The trust configuration and replay state are intentionally
// external to repositoryRoot; neither candidate JSON nor agent code can mint a
// valid waiver.
func ValidateWaiverFile(path, trustConfigPath, replayStatePath, repositoryRoot, expectedRepository, expectedTicket, expectedRow, expectedPlan, expectedBase, expectedHead string, expectedPR int) error {
	data, err := boundedRead(path, "delivery waiver", 256*1024)
	if err != nil {
		return err
	}
	if err := validatePublishedSchema(repositoryRoot, "waiver-v1.schema.json", data, "delivery waiver"); err != nil {
		return err
	}
	var waiver DeliveryWaiver
	if err := decodeStrictJSON(data, &waiver); err != nil {
		return err
	}
	config, keys, err := loadTrustedWaiverConfig(trustConfigPath, repositoryRoot)
	if err != nil {
		return err
	}
	if err := validateWaiver(waiver, config, keys, expectedRepository, expectedTicket, expectedRow, expectedPlan, expectedBase, expectedHead, expectedPR, time.Now().UTC()); err != nil {
		return err
	}
	return consumeWaiverNonces(replayStatePath, repositoryRoot, []DeliveryWaiver{waiver}, time.Now().UTC())
}

func validateMatrixRow(row AcceptanceMatrixRow, planRow AcceptancePlanRow, repositoryRoot, expectedRepository, expectedTicket, expectedPlan, expectedBase, expectedHead string, expectedPR int, trustConfigPath, replayStatePath string, now time.Time) (*DeliveryWaiver, bool, error) {
	if !acceptanceIDRe.MatchString(row.ID) || row.ID != planRow.ID {
		return nil, false, fmt.Errorf("acceptance matrix contains an unknown or duplicate row ID %q", row.ID)
	}
	switch row.Status {
	case "observed":
		if row.Observed == nil || row.Waiver != nil || row.Blocker != nil {
			return nil, false, fmt.Errorf("observed row %q must contain only observed evidence", row.ID)
		}
		observed := row.Observed
		if planRow.AcceptanceClass == "requirement" {
			return nil, false, fmt.Errorf("durable requirement row %q remains blocked until external evidence or a valid waiver exists", row.ID)
		}
		if observed.AcceptanceClass != planRow.AcceptanceClass || strings.TrimSpace(observed.Verifier) == "" || strings.TrimSpace(observed.Command) == "" || strings.TrimSpace(observed.ToolVersion) == "" || observed.ExitStatus != 0 || len(observed.Artifacts) == 0 {
			return nil, false, fmt.Errorf("observed row %q lacks class-specific evidence", row.ID)
		}
		started, err := parseTime(observed.StartedAt, "observed started_at")
		if err != nil {
			return nil, false, err
		}
		completed, err := parseTime(observed.CompletedAt, "observed completed_at")
		if err != nil {
			return nil, false, err
		}
		if completed.Before(started) || completed.After(now.Add(maxWaiverFutureSkew)) {
			return nil, false, fmt.Errorf("observed row %q timestamps are invalid", row.ID)
		}
		seenArtifacts := map[string]struct{}{}
		for _, artifact := range observed.Artifacts {
			if err := validateRelativePath(artifact.Name, "artifact name"); err != nil || !hex64Re.MatchString(artifact.SHA256) || artifact.Bytes < 0 || artifact.Bytes > 10*1024*1024 {
				return nil, false, fmt.Errorf("observed row %q contains an invalid artifact digest", row.ID)
			}
			if _, exists := seenArtifacts[artifact.Name]; exists {
				return nil, false, fmt.Errorf("observed row %q contains duplicate artifact evidence", row.ID)
			}
			seenArtifacts[artifact.Name] = struct{}{}
		}
		if strings.HasPrefix(planRow.AcceptanceClass, "benchmark-") {
			if observed.BenchmarkEvidence == nil {
				return nil, false, fmt.Errorf("benchmark row %q lacks benchmark evidence", row.ID)
			}
			fullPath, err := containedRegularFile(repositoryRoot, observed.BenchmarkEvidence.Path, "benchmark evidence path")
			if err != nil {
				return nil, false, err
			}
			data, err := boundedRead(fullPath, "benchmark evidence", maxAcceptanceJSONBytes)
			if err != nil {
				return nil, false, err
			}
			if fileSHA256(data) != observed.BenchmarkEvidence.SHA256 {
				return nil, false, fmt.Errorf("benchmark evidence digest does not match its bytes")
			}
			if err := validatePublishedSchema(repositoryRoot, "benchmark-evidence-v1.schema.json", data, "benchmark evidence"); err != nil {
				return nil, false, err
			}
			var benchmark BenchmarkEvidence
			if err := decodeStrictJSON(data, &benchmark); err != nil {
				return nil, false, err
			}
			benchmarkClass := "ci-regression"
			if planRow.AcceptanceClass == "benchmark-local-10m" {
				benchmarkClass = "local-10m"
			}
			if err := validateBenchmarkEvidence(benchmark, expectedRepository, expectedBase, expectedHead, benchmarkClass, now); err != nil {
				return nil, false, err
			}
		}
		return nil, false, nil
	case "waived":
		if row.Waiver == nil || row.Observed != nil || row.Blocker != nil {
			return nil, false, fmt.Errorf("waived row %q must contain only a signed waiver", row.ID)
		}
		if trustConfigPath == "" || replayStatePath == "" {
			return nil, false, fmt.Errorf("waived row %q is blocked because the trusted verifier or replay state is missing", row.ID)
		}
		config, keys, err := loadTrustedWaiverConfig(trustConfigPath, repositoryRoot)
		if err != nil {
			return nil, false, err
		}
		if err := validateWaiver(*row.Waiver, config, keys, expectedRepository, expectedTicket, row.ID, expectedPlan, expectedBase, expectedHead, expectedPR, now); err != nil {
			return nil, false, err
		}
		return row.Waiver, true, nil
	case "blocked":
		if row.Blocker == nil || strings.TrimSpace(row.Blocker.Reason) == "" || row.Observed != nil || row.Waiver != nil {
			return nil, false, fmt.Errorf("blocked row %q must contain only a bounded blocker reason", row.ID)
		}
		return nil, true, nil
	default:
		return nil, false, fmt.Errorf("acceptance row %q has invalid status %q", row.ID, row.Status)
	}
}

// ValidateAcceptanceMatrixFile validates a matrix using the bindings recorded
// by the manifest. Production callers should use the Bundle variant with the
// trusted base/head/repository/PR values supplied by protected metadata.
func ValidateAcceptanceMatrixFile(manifestPath, matrixPath, repositoryRoot string) error {
	return ValidateAcceptanceMatrixBundle(manifestPath, matrixPath, repositoryRoot, "", "", "", 0, "", "")
}

// ValidateAcceptanceMatrixBundle validates exact row coverage and all
// class-specific evidence. A blocked matrix is reported as a blocker rather
// than being treated as a completion result.
func ValidateAcceptanceMatrixBundle(manifestPath, matrixPath, repositoryRoot, expectedRepository, expectedBase, expectedHead string, expectedPR int, trustConfigPath, replayStatePath string) error {
	manifestData, err := boundedRead(manifestPath, "acceptance manifest", maxAcceptanceJSONBytes)
	if err != nil {
		return err
	}
	if err := validatePublishedSchema(repositoryRoot, "acceptance-manifest-v1.schema.json", manifestData, "acceptance manifest"); err != nil {
		return err
	}
	var manifest AcceptanceManifest
	if err := decodeStrictJSON(manifestData, &manifest); err != nil {
		return err
	}
	if _, planRows, err := validateAcceptanceManifest(manifest, repositoryRoot, expectedRepository, expectedBase); err != nil {
		return err
	} else {
		matrixData, err := boundedRead(matrixPath, "acceptance matrix", maxAcceptanceJSONBytes)
		if err != nil {
			return err
		}
		if err := validatePublishedSchema(repositoryRoot, "acceptance-matrix-v1.schema.json", matrixData, "acceptance matrix"); err != nil {
			return err
		}
		var matrix AcceptanceMatrix
		if err := decodeStrictJSON(matrixData, &matrix); err != nil {
			return err
		}
		if matrix.SchemaVersion != AcceptanceMatrixSchemaVersion || matrix.TicketID != manifest.TicketID || matrix.Repository != manifest.Repository || matrix.PlanSHA256 != manifest.PlanSHA256 || matrix.BaseSHA != manifest.BaseSHA || matrix.ManifestSHA256 != fileSHA256(manifestData) {
			return fmt.Errorf("acceptance matrix is not immutably bound to the approved manifest")
		}
		if err := validateAcceptanceSHA(matrix.HeadSHA, "head_sha"); err != nil || (expectedHead != "" && matrix.HeadSHA != expectedHead) || (expectedRepository != "" && matrix.Repository != expectedRepository) || (expectedBase != "" && matrix.BaseSHA != expectedBase) {
			return fmt.Errorf("acceptance matrix repository or Git binding is invalid")
		}
		if matrix.PullRequestNumber < 1 || (expectedPR > 0 && matrix.PullRequestNumber != expectedPR) {
			return fmt.Errorf("acceptance matrix pull request binding is invalid")
		}
		if _, err := parseTime(matrix.GeneratedAt, "matrix generated_at"); err != nil {
			return err
		}
		if len(matrix.Rows) != len(planRows) || len(matrix.Rows) == 0 || len(matrix.Rows) > maxAcceptanceRows {
			return fmt.Errorf("acceptance matrix does not cover every approved row exactly once")
		}
		seen := map[string]struct{}{}
		waivers := make([]DeliveryWaiver, 0)
		blocked := 0
		for _, row := range matrix.Rows {
			if _, exists := seen[row.ID]; exists {
				return fmt.Errorf("acceptance matrix duplicates row %q", row.ID)
			}
			planRow, exists := planRows[row.ID]
			if !exists {
				return fmt.Errorf("acceptance matrix contains unknown row %q", row.ID)
			}
			seen[row.ID] = struct{}{}
			waiver, isBlocked, err := validateMatrixRow(row, planRow, repositoryRoot, expectedRepository, manifest.TicketID, manifest.PlanSHA256, manifest.BaseSHA, matrix.HeadSHA, expectedPR, trustConfigPath, replayStatePath, time.Now().UTC())
			if err != nil {
				return err
			}
			if waiver != nil {
				waivers = append(waivers, *waiver)
			}
			if row.Status == "blocked" || isBlocked && row.Status == "blocked" {
				blocked++
			}
		}
		if len(seen) != len(planRows) {
			return fmt.Errorf("acceptance matrix omits one or more approved rows")
		}
		if blocked > 0 {
			return fmt.Errorf("acceptance matrix contains %d blocked row(s)", blocked)
		}
		if len(waivers) > 0 {
			if err := consumeWaiverNonces(replayStatePath, repositoryRoot, waivers, time.Now().UTC()); err != nil {
				return err
			}
		}
	}
	return nil
}

// ValidateAcceptanceBundle is the strict completion validator. A truthful
// blocked matrix can be inspected separately, but it cannot satisfy delivery.
func ValidateAcceptanceBundle(manifestPath, matrixPath, repositoryRoot, expectedRepository, expectedBase, expectedHead string, expectedPR int, trustConfigPath, replayStatePath string) error {
	return ValidateAcceptanceMatrixBundle(manifestPath, matrixPath, repositoryRoot, expectedRepository, expectedBase, expectedHead, expectedPR, trustConfigPath, replayStatePath)
}
