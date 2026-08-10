// Package deliveryevidence validates repository-tracked delivery evidence without
// contacting external services or reading credentials.
package deliveryevidence

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const SchemaVersion = "delivery-evidence/v1"

var (
	ticketID      = regexp.MustCompile(`^[A-Z][A-Z0-9]+-[1-9][0-9]*$`)
	commitSHA     = regexp.MustCompile(`^[a-f0-9]{40}$`)
	sourceID      = regexp.MustCompile(`^SRC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}$`)
	wikiPageID    = regexp.MustCompile(`^(concepts|entities|requirements|analys(e|i)s|cases|skills|synthesis)/[a-z0-9][a-z0-9-]*$`)
	observationID = regexp.MustCompile(`^obs-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$`)
	sha256Digest  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	developerID   = regexp.MustCompile(`^sha256:[a-f0-9]{16}$`)
	harnessTypeRe = regexp.MustCompile(`^(pi|jules)$`)
	providerRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	modelRe       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	thinkingRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)
)

type Manifest struct {
	SchemaVersion string          `json:"schema_version"`
	TicketID      string          `json:"ticket_id"`
	OKFPath       string          `json:"okf_path"`
	DeliveryState string          `json:"delivery_state"`
	PullRequest   PullRequest     `json:"pull_request"`
	CommitSHA     string          `json:"commit_sha"`
	Wiki          WikiEvidence    `json:"wiki"`
	Verifications []CommandResult `json:"verifications"`
	Harness       *Harness        `json:"harness,omitempty"`
	Review        ReviewEvidence  `json:"review"`
	Merge         MergeEvidence   `json:"merge"`
}

// Harness captures optional deterministic cost/usage metadata for multi-dev
// cost-per-task reporting. All fields are optional; missing harness is
// reported as "unknown" in stratified aggregates (WORK-118/119). No raw
// prompts, transcripts, credentials, or PII are stored — developer_id is
// sha256(lowercase(trim(email)))[:16] prefixed as "sha256:<hex>".
type Harness struct {
	Provider         string            `json:"provider,omitempty"`
	Model            string            `json:"model,omitempty"`
	ThinkingLevel    string            `json:"thinkingLevel,omitempty"`
	ThinkingLevelMap map[string]string `json:"thinkingLevelMap,omitempty"`
	Usage            *HarnessUsage     `json:"usage,omitempty"`
	Cost             *HarnessCost      `json:"cost,omitempty"`
	ElapsedMs        *int64            `json:"elapsedMs,omitempty"`
	HarnessType      string            `json:"harnessType,omitempty"`
	DeveloperID      string            `json:"developer_id,omitempty"`
}

type HarnessUsage struct {
	Input       *int64 `json:"input,omitempty"`
	Output      *int64 `json:"output,omitempty"`
	Reasoning   *int64 `json:"reasoning,omitempty"`
	CacheRead   *int64 `json:"cacheRead,omitempty"`
	CacheWrite  *int64 `json:"cacheWrite,omitempty"`
	TotalTokens *int64 `json:"totalTokens,omitempty"`
}

type HarnessCost struct {
	Input      *float64 `json:"input,omitempty"`
	Output     *float64 `json:"output,omitempty"`
	CacheRead  *float64 `json:"cacheRead,omitempty"`
	CacheWrite *float64 `json:"cacheWrite,omitempty"`
	Total      *float64 `json:"total,omitempty"`
}

type PullRequest struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
	Draft  bool   `json:"draft"`
}
type WikiEvidence struct {
	SourceIDs      []string `json:"source_ids"`
	PageIDs        []string `json:"page_ids"`
	ObservationIDs []string `json:"observation_ids"`
}
type CommandResult struct {
	Command        string `json:"command"`
	ExitCode       int    `json:"exit_code"`
	Outcome        string `json:"outcome"`
	OutputSHA256   string `json:"output_sha256"`
	FailureMarker  string `json:"failure_marker,omitempty"`
	Classification string `json:"classification,omitempty"`
	Reason         string `json:"reason,omitempty"`
}
type ReviewEvidence struct {
	Verdict   string `json:"verdict"`
	CommitSHA string `json:"commit_sha"`
}
type MergeEvidence struct {
	Status    string `json:"status"`
	CommitSHA string `json:"commit_sha,omitempty"`
}

// ValidateFile validates a JSON manifest against only the supplied repository root.
func ValidateFile(manifestPath, repositoryRoot string) error {
	return ValidateFileAtCommit(manifestPath, repositoryRoot, "")
}

// ValidateFileAtCommit validates a manifest against the immutable delivery commit
// selected by the caller. expectedCommit is mandatory so production callers cannot
// silently accept stale evidence.
func ValidateFileAtCommit(manifestPath, repositoryRoot, expectedCommit string) error {
	if !commitSHA.MatchString(expectedCommit) {
		return fmt.Errorf("expected delivery commit must be a 40-character lowercase SHA")
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	var manifest Manifest
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return fmt.Errorf("decode manifest: %w", err)
	}
	if err := Validate(manifest, repositoryRoot); err != nil {
		return err
	}
	if manifest.CommitSHA != expectedCommit {
		return fmt.Errorf("manifest commit_sha %q does not match expected delivery commit %q", manifest.CommitSHA, expectedCommit)
	}
	return nil
}

func Validate(m Manifest, repositoryRoot string) error {
	if m.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported schema_version %q", m.SchemaVersion)
	}
	if !ticketID.MatchString(m.TicketID) {
		return fmt.Errorf("invalid ticket_id %q", m.TicketID)
	}
	if !commitSHA.MatchString(m.CommitSHA) {
		return fmt.Errorf("invalid commit_sha")
	}
	if m.PullRequest.Number < 1 || !strings.HasPrefix(m.PullRequest.URL, "https://") {
		return fmt.Errorf("pull_request requires positive number and https URL")
	}
	if err := validateContainedOKF(m.OKFPath, repositoryRoot); err != nil {
		return err
	}
	if err := validateIDs("source", m.Wiki.SourceIDs, sourceID); err != nil {
		return err
	}
	if err := validateIDs("page", m.Wiki.PageIDs, wikiPageID); err != nil {
		return err
	}
	if err := validateIDs("observation", m.Wiki.ObservationIDs, observationID); err != nil {
		return err
	}
	if len(m.Verifications) == 0 {
		return fmt.Errorf("verifications must not be empty")
	}
	for i, result := range m.Verifications {
		if err := validateCommand(i, result); err != nil {
			return err
		}
	}
	if m.Harness != nil {
		if err := validateHarness(m.Harness); err != nil {
			return err
		}
	}
	if m.Review.CommitSHA != m.CommitSHA {
		return fmt.Errorf("review commit_sha must match commit_sha")
	}
	if m.Merge.Status == "merged" && m.Merge.CommitSHA != m.CommitSHA {
		return fmt.Errorf("merged evidence must name the delivery commit")
	}
	if m.Merge.Status != "not_merged" && m.Merge.Status != "merged" {
		return fmt.Errorf("invalid merge status %q", m.Merge.Status)
	}
	if m.DeliveryState != "review_ready" && m.DeliveryState != "published" && m.DeliveryState != "merged" {
		return fmt.Errorf("invalid delivery_state %q", m.DeliveryState)
	}
	if m.DeliveryState == "review_ready" && (!m.PullRequest.Draft || m.Merge.Status != "not_merged" || m.Review.Verdict != "self_review_complete") {
		return fmt.Errorf("review_ready requires a draft, unmerged PR and self_review_complete verdict")
	}
	if m.DeliveryState == "published" && (m.PullRequest.Draft || m.Merge.Status != "not_merged" || m.Review.Verdict != "approved") {
		return fmt.Errorf("published requires a non-draft, unmerged PR and approved verdict")
	}
	if m.DeliveryState == "merged" && (m.Merge.Status != "merged" || m.Review.Verdict != "approved") {
		return fmt.Errorf("merged requires merge evidence and approved verdict")
	}
	return nil
}

func validateContainedOKF(path, root string) error {
	if path == "" || filepath.IsAbs(path) || filepath.Ext(path) != ".md" {
		return fmt.Errorf("okf_path must be a relative Markdown path")
	}
	full := filepath.Join(root, path)
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("okf_path escapes repository root")
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return fmt.Errorf("read OKF: %w", err)
	}
	if !strings.HasPrefix(string(data), "---") {
		return fmt.Errorf("OKF must start with YAML frontmatter")
	}
	firstLineEnd := strings.IndexByte(string(data), '\n')
	if firstLineEnd < 0 || strings.TrimSuffix(string(data[:firstLineEnd]), "\r") != "---" {
		return fmt.Errorf("OKF must start with YAML frontmatter")
	}
	normalized := strings.ReplaceAll(string(data), "\r\n", "\n")
	parts := strings.SplitN(normalized, "---\n", 3)
	if len(parts) != 3 || parts[0] != "" {
		return fmt.Errorf("OKF must start with YAML frontmatter")
	}
	var frontmatter map[string]any
	if err := yaml.Unmarshal([]byte(parts[1]), &frontmatter); err != nil {
		return fmt.Errorf("parse OKF frontmatter: %w", err)
	}
	for _, key := range []string{"type", "title", "timestamp"} {
		if strings.TrimSpace(fmt.Sprint(frontmatter[key])) == "" || frontmatter[key] == nil {
			return fmt.Errorf("OKF frontmatter missing %s", key)
		}
	}
	return nil
}

func validateIDs(kind string, values []string, format *regexp.Regexp) error {
	if len(values) == 0 {
		return fmt.Errorf("%s IDs must not be empty", kind)
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !format.MatchString(value) {
			return fmt.Errorf("malformed %s ID %q", kind, value)
		}
		if seen[value] {
			return fmt.Errorf("duplicate %s ID %q", kind, value)
		}
		seen[value] = true
	}
	return nil
}

func validateCommand(index int, r CommandResult) error {
	if strings.TrimSpace(r.Command) == "" || !sha256Digest.MatchString(r.OutputSHA256) {
		return fmt.Errorf("verification %d lacks complete command result", index)
	}
	switch r.Outcome {
	case "passed":
		if r.ExitCode != 0 || r.FailureMarker != "" || r.Classification != "" || r.Reason != "" {
			return fmt.Errorf("passed verification %d has contradictory failure evidence", index)
		}
	case "failed":
		if r.ExitCode == 0 || r.FailureMarker == "" {
			return fmt.Errorf("failed verification %d requires non-zero exit and failure marker", index)
		}
	case "environment_only":
		if r.ExitCode != 0 || r.FailureMarker == "" || r.Classification != "environment_only" || strings.TrimSpace(r.Reason) == "" {
			return fmt.Errorf("environment-only verification %d requires exit zero, marker, classification, and reason", index)
		}
	default:
		return fmt.Errorf("invalid verification outcome %q", r.Outcome)
	}
	return nil
}

// DigestOutput returns the canonical SHA-256 digest recorded for command output.
func DigestOutput(output []byte) string {
	sum := sha256.Sum256(output)
	return hex.EncodeToString(sum[:])
}

// DeveloperIDForEmail returns the anonymized developer_id for a git commit
// author email. Never persists raw email/PII; only the hash digest.
func DeveloperIDForEmail(email string) string {
	normalized := strings.ToLower(strings.TrimSpace(email))
	sum := sha256.Sum256([]byte(normalized))
	return "sha256:" + hex.EncodeToString(sum[:])[:16]
}

func validateHarness(h *Harness) error {
	if h.Provider != "" && !providerRe.MatchString(h.Provider) {
		return fmt.Errorf("invalid harness.provider %q", h.Provider)
	}
	if h.Model != "" && !modelRe.MatchString(h.Model) {
		return fmt.Errorf("invalid harness.model %q", h.Model)
	}
	if h.ThinkingLevel != "" && !thinkingRe.MatchString(h.ThinkingLevel) {
		return fmt.Errorf("invalid harness.thinkingLevel %q", h.ThinkingLevel)
	}
	for k, v := range h.ThinkingLevelMap {
		if !thinkingRe.MatchString(k) || !thinkingRe.MatchString(v) {
			return fmt.Errorf("invalid harness.thinkingLevelMap entry %q:%q", k, v)
		}
	}
	if h.HarnessType != "" && !harnessTypeRe.MatchString(h.HarnessType) {
		return fmt.Errorf("invalid harness.harnessType %q (must be pi or jules)", h.HarnessType)
	}
	if h.DeveloperID != "" && !developerID.MatchString(h.DeveloperID) {
		return fmt.Errorf("invalid harness.developer_id %q (must be sha256:<16 hex>)", h.DeveloperID)
	}
	if h.Usage != nil {
		if err := validateHarnessUsage(h.Usage); err != nil {
			return err
		}
	}
	if h.Cost != nil {
		if err := validateHarnessCost(h.Cost); err != nil {
			return err
		}
	}
	if h.ElapsedMs != nil {
		if *h.ElapsedMs < 0 || *h.ElapsedMs > 7*24*60*60*1000 { // max 7 days
			return fmt.Errorf("invalid harness.elapsedMs %d", *h.ElapsedMs)
		}
	}
	return nil
}

func validateHarnessUsage(u *HarnessUsage) error {
	for name, v := range map[string]*int64{
		"input": u.Input, "output": u.Output, "reasoning": u.Reasoning,
		"cacheRead": u.CacheRead, "cacheWrite": u.CacheWrite, "totalTokens": u.TotalTokens,
	} {
		if v != nil && *v < 0 {
			return fmt.Errorf("invalid harness.usage.%s %d", name, *v)
		}
	}
	return nil
}

func validateHarnessCost(c *HarnessCost) error {
	for name, v := range map[string]*float64{
		"input": c.Input, "output": c.Output, "cacheRead": c.CacheRead,
		"cacheWrite": c.CacheWrite, "total": c.Total,
	} {
		if v != nil {
			if *v < 0 || *v > 1_000_000 {
				return fmt.Errorf("invalid harness.cost.%s %v", name, *v)
			}
		}
	}
	return nil
}
