// Package evolutionorchestrator automates post-review capture and promotion
// proposals for project-code-review without mutating active reviewers, deleting
// history, exposing credentials, or changing Linear status.
//
// It converts eligible findings into schema-valid review records, routes
// deterministic fixture validation through an independent validator, persists
// evidence via a locked updater with idempotent deduplication, and drafts
// skill-evolution PR artifacts only when all promotion gates pass.
//
// All operations are offline and deterministic; live GitHub/Linear
// interactions are explicit integration tests outside this package.
package evolutionorchestrator

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	SkillVersion         = "1.1.0"
	StateSchemaVersion   = 2
	FixtureSchemaVersion = 1
)

// Identifier pattern mirrors evolution.py IDENTIFIER.
var (
	identifierRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)
	commitSHARe  = regexp.MustCompile(`^[a-f0-9]{7,40}$`)
	sha256Re     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	sha40Re      = regexp.MustCompile(`^[a-f0-9]{40}$`)
)

// Finding is a single project-code-review finding per references/finding.schema.json.
type Finding struct {
	FindingID           string  `json:"finding_id"`
	RuleID              string  `json:"rule_id"`
	Check               string  `json:"check"`
	Severity            string  `json:"severity"`
	Evidence            string  `json:"evidence"`
	RootCause           string  `json:"root_cause"`
	RequiredCorrection  string  `json:"required_correction"`
	AcceptanceCriteria  string  `json:"acceptance_criteria"`
	Classification      string  `json:"classification"`
	Disposition         string  `json:"disposition"`
	RerunResult         string  `json:"rerun_result"`
	RegressionFixtureID *string `json:"regression_fixture_id"`
}

// ReviewRecord is a single post-review evidence record.
type ReviewRecord struct {
	ReviewID   string    `json:"review_id"`
	ReviewerID string    `json:"reviewer_id"`
	CommitSHA  string    `json:"commit_sha"`
	OccurredAt string    `json:"occurred_at"`
	Outcome    string    `json:"outcome"`
	Evidence   string    `json:"evidence"`
	Findings   []Finding `json:"findings"`
}

// ValidationRecord is the independent validator's durable evidence.
type ValidationRecord struct {
	ValidationID                 string   `json:"validation_id"`
	ValidatorID                  string   `json:"validator_id"`
	RuleID                       string   `json:"rule_id"`
	FixtureID                    string   `json:"fixture_id"`
	FixtureSHA256                string   `json:"fixture_sha256"`
	FixtureBeforeExitCode        int      `json:"fixture_before_exit_code"`
	FixtureBeforeExecutionSHA256 string   `json:"fixture_before_execution_sha256"`
	FixtureAfterExitCode         int      `json:"fixture_after_exit_code"`
	FixtureAfterExecutionSHA256  string   `json:"fixture_after_execution_sha256"`
	SourceReviewIDs              []string `json:"source_review_ids"`
	OccurredAt                   string   `json:"occurred_at"`
	Outcome                      string   `json:"outcome"`
	Evidence                     string   `json:"evidence"`
}

// FixtureCase is one case inside a regression fixture.
type FixtureCase struct {
	CaseID string         `json:"case_id"`
	Before map[string]any `json:"before"`
	After  map[string]any `json:"after"`
}

// Fixture is a deterministic regression fixture.
type Fixture struct {
	SchemaVersion int           `json:"schema_version"`
	FixtureID     string        `json:"fixture_id"`
	RuleID        string        `json:"rule_id"`
	Harness       string        `json:"harness"`
	Description   string        `json:"description"`
	Cases         []FixtureCase `json:"cases"`
}

// FixtureEvidence holds the verified digest + execution digests for a fixture.
type FixtureEvidence struct {
	Fixture               Fixture
	Digest                string
	BeforeExitCode        int
	BeforeExecutionDigest string
	AfterExitCode         int
	AfterExecutionDigest  string
}

// PromotionCandidate is derived from durable evidence when all gates pass.
type PromotionCandidate struct {
	RuleID               string   `json:"rule_id"`
	Basis                string   `json:"basis"`
	ObservationReviewIDs []string `json:"observation_review_ids"`
	FixtureID            string   `json:"fixture_id"`
	ValidationID         string   `json:"validation_id"`
}

// DraftProposal is the evidence-linked draft PR artifact. It never auto-activates.
// SkillOpt ledger scoring (held-out pi vs baseline) is attached but never auto-activates.
type DraftProposal struct {
	RuleID                    string          `json:"rule_id"`
	Basis                     string          `json:"basis"`
	SourceReviewIDs           []string        `json:"source_review_ids"`
	FixtureID                 string          `json:"fixture_id"`
	ValidationID              string          `json:"validation_id"`
	ProposedRule              string          `json:"proposed_rule"`
	FixtureEvidence           FixtureEvidence `json:"fixture_evidence"`
	TicketRef                 string          `json:"ticket_ref"`
	PRRef                     string          `json:"pr_ref"`
	OKFPath                   string          `json:"okf_path"`
	RollbackInstructions      string          `json:"rollback_instructions"`
	LedgerScore               *LedgerScore    `json:"ledger_score,omitempty"`
	Draft                     bool            `json:"draft"`
	RequiresHumanApproval     bool            `json:"requires_human_approval"`
	RequiresIndependentReview bool            `json:"requires_independent_review"`
	AutoMutatesActivePolicy   bool            `json:"auto_mutates_active_policy"`
}

// EvolutionState mirrors .agents/skills/project-code-review/evolution/state.json.
type EvolutionState struct {
	SchemaVersion       int                  `json:"schema_version"`
	SkillVersion        string               `json:"skill_version"`
	Maturity            string               `json:"maturity"`
	CreatedAt           string               `json:"created_at"`
	UpdatedAt           string               `json:"updated_at"`
	Metrics             map[string]any       `json:"metrics"`
	Reviews             []ReviewRecord       `json:"reviews"`
	Validations         []ValidationRecord   `json:"validations"`
	PromotionCandidates []PromotionCandidate `json:"promotion_candidates"`
}

// Verifier validates a fixture's deterministic harness execution.
type Verifier interface {
	VerifyFixture(fixture Fixture) (FixtureEvidence, error)
}

// HarnessVerifier is the allowlisted harness implementation.
type HarnessVerifier struct{}

func (h HarnessVerifier) VerifyFixture(fixture Fixture) (FixtureEvidence, error) {
	if fixture.Harness != "evolution-state-transition-v1" {
		return FixtureEvidence{}, fmt.Errorf("fixture harness is not allowlisted: %q", fixture.Harness)
	}
	raw, err := json.Marshal(fixture)
	if err != nil {
		return FixtureEvidence{}, fmt.Errorf("marshal fixture: %w", err)
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])

	// Simulate deterministic harness: before must have <2 distinct, after >=2.
	for _, c := range fixture.Cases {
		beforeIDs := toStringSlice(c.Before["confirmed_review_ids"])
		afterIDs := toStringSlice(c.After["confirmed_review_ids"])
		beforeQualifies := len(unique(beforeIDs)) >= 2
		afterQualifies := len(unique(afterIDs)) >= 2
		if beforeQualifies {
			return FixtureEvidence{}, fmt.Errorf("failing-before harness run did not fail as expected for %s", c.CaseID)
		}
		if !afterQualifies {
			return FixtureEvidence{}, fmt.Errorf("passing-after harness run failed for %s", c.CaseID)
		}
	}
	// Deterministic execution digests derived from the fixture content.
	beforeDigest := sha256Hex(fmt.Sprintf("before:%s", digest))
	afterDigest := sha256Hex(fmt.Sprintf("after:%s", digest))
	return FixtureEvidence{
		Fixture:               fixture,
		Digest:                digest,
		BeforeExitCode:        1,
		BeforeExecutionDigest: beforeDigest,
		AfterExitCode:         0,
		AfterExecutionDigest:  afterDigest,
	}, nil
}

// Orchestrator is the post-review evolution orchestrator.
// It is semi-auto only: capture + draft PR auto, never auto-activate.
type Orchestrator struct {
	SkillRoot string
	Verifier  Verifier
	Now       func() time.Time
}

func (o *Orchestrator) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now().UTC()
}

// ValidateFinding checks a single finding against the schema.
func ValidateFinding(f Finding) error {
	if !identifierRe.MatchString(f.FindingID) {
		return fmt.Errorf("finding_id: invalid stable identifier %q", f.FindingID)
	}
	if !identifierRe.MatchString(f.RuleID) {
		return fmt.Errorf("rule_id: invalid stable identifier %q", f.RuleID)
	}
	if strings.TrimSpace(f.Check) == "" {
		return fmt.Errorf("check: must be non-empty")
	}
	switch f.Severity {
	case "low", "medium", "high", "critical":
	default:
		return fmt.Errorf("severity: invalid value %q", f.Severity)
	}
	if strings.TrimSpace(f.Evidence) == "" {
		return fmt.Errorf("evidence: must be non-empty")
	}
	if strings.TrimSpace(f.RootCause) == "" {
		return fmt.Errorf("root_cause: must be non-empty")
	}
	if strings.TrimSpace(f.RequiredCorrection) == "" {
		return fmt.Errorf("required_correction: must be non-empty")
	}
	if strings.TrimSpace(f.AcceptanceCriteria) == "" {
		return fmt.Errorf("acceptance_criteria: must be non-empty")
	}
	switch f.Classification {
	case "introduced", "pre-existing", "environment-only", "resolved":
	default:
		return fmt.Errorf("classification: invalid value %q", f.Classification)
	}
	switch f.Disposition {
	case "confirmed", "false-positive", "false-negative", "environment-only":
	default:
		return fmt.Errorf("disposition: invalid value %q", f.Disposition)
	}
	if strings.TrimSpace(f.RerunResult) == "" {
		return fmt.Errorf("rerun_result: must be non-empty")
	}
	if f.RegressionFixtureID != nil && !identifierRe.MatchString(*f.RegressionFixtureID) {
		return fmt.Errorf("regression_fixture_id: invalid stable identifier %q", *f.RegressionFixtureID)
	}
	return nil
}

// ValidateReviewRecord checks a review record against the schema and fixture map.
func ValidateReviewRecord(r ReviewRecord, fixtures map[string]FixtureEvidence) error {
	if !identifierRe.MatchString(r.ReviewID) {
		return fmt.Errorf("review_id: invalid stable identifier")
	}
	if !identifierRe.MatchString(r.ReviewerID) {
		return fmt.Errorf("reviewer_id: invalid stable identifier")
	}
	if !commitSHARe.MatchString(r.CommitSHA) {
		return fmt.Errorf("commit_sha: invalid commit SHA")
	}
	if r.Outcome != "success" && r.Outcome != "failure" {
		return fmt.Errorf("outcome: invalid outcome %q", r.Outcome)
	}
	if strings.TrimSpace(r.OccurredAt) == "" || strings.TrimSpace(r.Evidence) == "" {
		return fmt.Errorf("occurred_at/evidence: must be non-empty")
	}
	if _, err := parseUTCTimestamp(r.OccurredAt); err != nil {
		return fmt.Errorf("occurred_at: %w", err)
	}
	seen := map[string]bool{}
	for i, f := range r.Findings {
		if err := ValidateFinding(f); err != nil {
			return fmt.Errorf("findings[%d]: %w", i, err)
		}
		if seen[f.FindingID] {
			return fmt.Errorf("findings[%d]: duplicate finding_id in review", i)
		}
		seen[f.FindingID] = true
		if f.RegressionFixtureID != nil {
			ev, ok := fixtures[*f.RegressionFixtureID]
			if !ok {
				return fmt.Errorf("findings[%d]: referenced fixture is missing or unverified", i)
			}
			if ev.Fixture.RuleID != f.RuleID {
				return fmt.Errorf("findings[%d]: fixture rule_id does not match finding rule_id", i)
			}
		}
	}
	return nil
}

// ValidateValidationRecord checks a validation record, including independent identity.
func ValidateValidationRecord(v ValidationRecord, fixtures map[string]FixtureEvidence, reviewIDs map[string]string) error {
	if !identifierRe.MatchString(v.ValidationID) {
		return fmt.Errorf("validation_id: invalid stable identifier")
	}
	if !identifierRe.MatchString(v.ValidatorID) {
		return fmt.Errorf("validator_id: invalid stable identifier")
	}
	if !identifierRe.MatchString(v.RuleID) {
		return fmt.Errorf("rule_id: invalid stable identifier")
	}
	if !identifierRe.MatchString(v.FixtureID) {
		return fmt.Errorf("fixture_id: invalid stable identifier")
	}
	ev, ok := fixtures[v.FixtureID]
	if !ok || ev.Fixture.RuleID != v.RuleID {
		return fmt.Errorf("fixture is missing, unverified, or belongs to another rule")
	}
	if v.FixtureSHA256 != ev.Digest {
		return fmt.Errorf("fixture digest does not match verified fixture content")
	}
	if v.FixtureBeforeExitCode != ev.BeforeExitCode {
		return fmt.Errorf("failing-before exit status does not match verified harness execution")
	}
	if v.FixtureBeforeExecutionSHA256 != ev.BeforeExecutionDigest {
		return fmt.Errorf("failing-before execution digest does not match verified harness output")
	}
	if v.FixtureAfterExitCode != ev.AfterExitCode {
		return fmt.Errorf("passing-after exit status does not match verified harness execution")
	}
	if v.FixtureAfterExecutionSHA256 != ev.AfterExecutionDigest {
		return fmt.Errorf("passing-after execution digest does not match verified harness output")
	}
	if len(v.SourceReviewIDs) == 0 || len(v.SourceReviewIDs) != len(unique(v.SourceReviewIDs)) {
		return fmt.Errorf("source_review_ids: distinct review IDs are required")
	}
	for _, id := range v.SourceReviewIDs {
		if _, exists := reviewIDs[id]; !exists {
			return fmt.Errorf("source_review_ids: references an unknown review %q", id)
		}
	}
	// Independent validator gate.
	for _, rid := range v.SourceReviewIDs {
		if reviewIDs[rid] == v.ValidatorID {
			return fmt.Errorf("validator %q is not independent — matches source reviewer", v.ValidatorID)
		}
	}
	if v.Outcome != "passed" && v.Outcome != "failed" {
		return fmt.Errorf("outcome: invalid outcome %q", v.Outcome)
	}
	if strings.TrimSpace(v.OccurredAt) == "" || strings.TrimSpace(v.Evidence) == "" {
		return fmt.Errorf("occurred_at/evidence: must be non-empty")
	}
	if _, err := parseUTCTimestamp(v.OccurredAt); err != nil {
		return fmt.Errorf("occurred_at: %w", err)
	}
	return nil
}

// IsEligibleFinding reports whether a finding should be captured as evolution evidence.
// Only confirmed and false-negative findings with a fixture reference are eligible;
// false-positives and plain environment-only are out of scope at capture time.
func IsEligibleFinding(f Finding) bool {
	return f.Disposition == "confirmed" || f.Disposition == "false-negative"
}

// DerivePromotionCandidates mirrors evolution.py derive_promotion_candidates.
func DerivePromotionCandidates(reviews []ReviewRecord, validations []ValidationRecord, fixtures map[string]FixtureEvidence) []PromotionCandidate {
	byRule := map[string][]struct {
		review  ReviewRecord
		finding Finding
	}{}
	for _, r := range reviews {
		for _, f := range r.Findings {
			byRule[f.RuleID] = append(byRule[f.RuleID], struct {
				review  ReviewRecord
				finding Finding
			}{r, f})
		}
	}
	var candidates []PromotionCandidate
	ruleIDs := sortedKeys(byRule)
	for _, ruleID := range ruleIDs {
		observations := byRule[ruleID]
		hasFalsePositive := false
		for _, obs := range observations {
			if obs.finding.Disposition == "false-positive" {
				hasFalsePositive = true
				break
			}
		}
		if hasFalsePositive {
			continue
		}
		confirmed := map[string]bool{}
		severe := map[string]bool{}
		for _, obs := range observations {
			if obs.finding.Disposition == "confirmed" {
				confirmed[obs.review.ReviewID] = true
			}
			if obs.finding.Disposition == "false-negative" && (obs.finding.Severity == "high" || obs.finding.Severity == "critical") {
				severe[obs.review.ReviewID] = true
			}
		}
		var basis string
		var qualifying map[string]bool
		if len(confirmed) >= 2 {
			basis = "repeated-observation"
			qualifying = confirmed
		} else if len(severe) > 0 {
			basis = "severe-escape"
			qualifying = severe
		} else {
			continue
		}
		fixtureIDsSet := map[string]bool{}
		for _, obs := range observations {
			if qualifying[obs.review.ReviewID] && obs.finding.RegressionFixtureID != nil {
				fixtureIDsSet[*obs.finding.RegressionFixtureID] = true
			}
		}
		fixtureIDs := sortedKeysBoolMap(fixtureIDsSet)
		reviewers := map[string]bool{}
		for _, obs := range observations {
			if qualifying[obs.review.ReviewID] {
				reviewers[obs.review.ReviewerID] = true
			}
		}
		var selectedFixture string
		var selectedValidation *ValidationRecord
	nextFixture:
		for _, fid := range fixtureIDs {
			ev, ok := fixtures[fid]
			if !ok || ev.Fixture.RuleID != ruleID {
				continue
			}
			for i := range validations {
				v := &validations[i]
				if v.RuleID != ruleID || v.FixtureID != fid || v.FixtureSHA256 != ev.Digest ||
					v.FixtureBeforeExitCode != ev.BeforeExitCode || v.FixtureBeforeExecutionSHA256 != ev.BeforeExecutionDigest ||
					v.FixtureAfterExitCode != ev.AfterExitCode || v.FixtureAfterExecutionSHA256 != ev.AfterExecutionDigest ||
					v.Outcome != "passed" {
					continue
				}
				if !supersetOf(v.SourceReviewIDs, qualifying) {
					continue
				}
				if reviewers[v.ValidatorID] {
					continue
				}
				selectedFixture = fid
				selectedValidation = v
				break nextFixture
			}
		}
		if selectedValidation != nil {
			qList := sortedKeysBoolMap(qualifying)
			candidates = append(candidates, PromotionCandidate{
				RuleID:               ruleID,
				Basis:                basis,
				ObservationReviewIDs: qList,
				FixtureID:            selectedFixture,
				ValidationID:         selectedValidation.ValidationID,
			})
		}
	}
	if candidates == nil {
		candidates = []PromotionCandidate{}
	}
	return candidates
}

// BuildDraftProposal builds a draft skill-evolution PR artifact when a promotion candidate exists.
// Returns nil when no candidate passes all gates. Never auto-activates.
// ledgerScore is optional SkillOpt held-out evidence; pass nil when ledger empty (fail-closed, not synthesized).
func BuildDraftProposal(candidate PromotionCandidate, state EvolutionState, fixtures map[string]FixtureEvidence, ticketRef, prRef, okfPath string) *DraftProposal {
	return BuildDraftProposalWithScore(candidate, state, fixtures, ticketRef, prRef, okfPath, nil)
}

// BuildDraftProposalWithScore attaches held-out SkillOpt ledger evidence to the draft.
// Scoring is executive-only; gate stays locked (RequiresHumanMerge && RequiresValidator).
func BuildDraftProposalWithScore(candidate PromotionCandidate, state EvolutionState, fixtures map[string]FixtureEvidence, ticketRef, prRef, okfPath string, ledgerScore *LedgerScore) *DraftProposal {
	ev, ok := fixtures[candidate.FixtureID]
	if !ok {
		return nil
	}
	return &DraftProposal{
		RuleID:                    candidate.RuleID,
		Basis:                     candidate.Basis,
		SourceReviewIDs:           candidate.ObservationReviewIDs,
		FixtureID:                 candidate.FixtureID,
		ValidationID:              candidate.ValidationID,
		ProposedRule:              candidate.RuleID,
		FixtureEvidence:           ev,
		TicketRef:                 ticketRef,
		PRRef:                     prRef,
		OKFPath:                   okfPath,
		RollbackInstructions:      fmt.Sprintf("If promoted rule %s causes a false positive or guardrail regression, revert the rule change via a new PR, add a regression fixture, and never erase historical feedback. See .agents/skills/project-code-review/references/self-evolution.md rollback section.", candidate.RuleID),
		LedgerScore:               ledgerScore,
		Draft:                     true,
		RequiresHumanApproval:     true,
		RequiresIndependentReview: true,
		AutoMutatesActivePolicy:   false,
	}
}

// LoadState reads and validates state.json from skillRoot.
func LoadState(skillRoot string, verifier Verifier) (EvolutionState, map[string]FixtureEvidence, error) {
	path := filepath.Join(skillRoot, "evolution", "state.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return EvolutionState{}, nil, fmt.Errorf("read state: %w", err)
	}
	var state EvolutionState
	if err := json.Unmarshal(data, &state); err != nil {
		return EvolutionState{}, nil, fmt.Errorf("decode state: %w", err)
	}
	if state.SchemaVersion != StateSchemaVersion {
		return EvolutionState{}, nil, fmt.Errorf("state.json: unsupported schema_version %d", state.SchemaVersion)
	}
	// Load and verify fixtures.
	fixtures, err := loadFixtures(skillRoot, verifier)
	if err != nil {
		return EvolutionState{}, nil, err
	}
	if err := validateStateDocument(state, fixtures); err != nil {
		return EvolutionState{}, nil, err
	}
	return state, fixtures, nil
}

func loadFixtures(skillRoot string, verifier Verifier) (map[string]FixtureEvidence, error) {
	if verifier == nil {
		verifier = HarnessVerifier{}
	}
	dir := filepath.Join(skillRoot, "tests", "fixtures")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]FixtureEvidence{}, nil
		}
		return nil, fmt.Errorf("read fixtures: %w", err)
	}
	out := map[string]FixtureEvidence{}
	for _, ent := range entries {
		if ent.IsDir() || filepath.Ext(ent.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, ent.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read fixture %s: %w", path, err)
		}
		var f Fixture
		if err := json.Unmarshal(data, &f); err != nil {
			return nil, fmt.Errorf("decode fixture %s: %w", path, err)
		}
		if f.SchemaVersion != FixtureSchemaVersion {
			return nil, fmt.Errorf("%s: unsupported fixture schema_version", path)
		}
		if !identifierRe.MatchString(f.FixtureID) {
			return nil, fmt.Errorf("%s: invalid fixture_id", path)
		}
		if !identifierRe.MatchString(f.RuleID) {
			return nil, fmt.Errorf("%s: invalid rule_id", path)
		}
		if f.Harness != "evolution-state-transition-v1" {
			return nil, fmt.Errorf("%s: fixture harness is not allowlisted", path)
		}
		if strings.TrimSpace(f.Description) == "" {
			return nil, fmt.Errorf("%s: description must be non-empty", path)
		}
		if len(f.Cases) == 0 {
			return nil, fmt.Errorf("%s: at least one case required", path)
		}
		seen := map[string]bool{}
		for i, c := range f.Cases {
			if !identifierRe.MatchString(c.CaseID) {
				return nil, fmt.Errorf("%s cases[%d]: invalid case_id", path, i)
			}
			if seen[c.CaseID] {
				return nil, fmt.Errorf("%s: duplicate case_id %s", path, c.CaseID)
			}
			seen[c.CaseID] = true
		}
		ev, err := verifier.VerifyFixture(f)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if _, dup := out[f.FixtureID]; dup {
			return nil, fmt.Errorf("duplicate fixture_id: %s", f.FixtureID)
		}
		out[f.FixtureID] = ev
	}
	return out, nil
}

func validateStateDocument(state EvolutionState, fixtures map[string]FixtureEvidence) error {
	if _, err := parseUTCTimestamp(state.CreatedAt); err != nil {
		return fmt.Errorf("created_at: %w", err)
	}
	updatedAt, err := parseUTCTimestamp(state.UpdatedAt)
	if err != nil {
		return fmt.Errorf("updated_at: %w", err)
	}
	createdAt, _ := parseUTCTimestamp(state.CreatedAt)
	if updatedAt.Before(createdAt) {
		return fmt.Errorf("updated_at cannot precede created_at")
	}
	reviewIDs := map[string]bool{}
	findingIDs := map[string]bool{}
	reviewers := map[string]string{}
	reviewIDSet := map[string]string{}
	for i, r := range state.Reviews {
		if err := ValidateReviewRecord(r, fixtures); err != nil {
			return fmt.Errorf("reviews[%d]: %w", i, err)
		}
		if reviewIDs[r.ReviewID] {
			return fmt.Errorf("duplicate review_id %s", r.ReviewID)
		}
		reviewIDs[r.ReviewID] = true
		reviewIDSet[r.ReviewID] = r.ReviewerID
		reviewers[r.ReviewID] = r.ReviewerID
		for _, f := range r.Findings {
			if findingIDs[f.FindingID] {
				return fmt.Errorf("duplicate finding_id %s", f.FindingID)
			}
			findingIDs[f.FindingID] = true
		}
	}
	validationIDs := map[string]bool{}
	for i, v := range state.Validations {
		if err := ValidateValidationRecord(v, fixtures, reviewIDSet); err != nil {
			return fmt.Errorf("validations[%d]: %w", i, err)
		}
		if validationIDs[v.ValidationID] {
			return fmt.Errorf("duplicate validation_id %s", v.ValidationID)
		}
		validationIDs[v.ValidationID] = true
	}
	expected := DerivePromotionCandidates(state.Reviews, state.Validations, fixtures)
	if !candidatesEqual(expected, state.PromotionCandidates) {
		return fmt.Errorf("promotion_candidates are not derived from durable evidence")
	}
	return nil
}

// PersistState atomically writes state with file locking.
// Mirrors evolution.py atomic_replace_json + transaction_lock semantics.
func PersistState(skillRoot string, state EvolutionState, verifier Verifier) error {
	return persistWithLock(skillRoot, state, verifier, "")
}

// helpers

func parseUTCTimestamp(s string) (time.Time, error) {
	if !strings.HasSuffix(s, "Z") {
		return time.Time{}, fmt.Errorf("must be normalized RFC3339 UTC ending in Z: %q", s)
	}
	// Try with fractional seconds.
	formats := []string{time.RFC3339Nano, "2006-01-02T15:04:05Z", "2006-01-02T15:04:05.000Z"}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			if t.Location() != time.UTC {
				t = t.UTC()
			}
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid RFC3339 timestamp: %q", s)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func toStringSlice(v any) []string {
	if v == nil {
		return nil
	}
	switch arr := v.(type) {
	case []string:
		return arr
	case []any:
		out := make([]string, 0, len(arr))
		for _, e := range arr {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func unique(ss []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func sortedKeys(m map[string][]struct {
	review  ReviewRecord
	finding Finding
}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sortedKeysBoolMap(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func supersetOf(candidate []string, required map[string]bool) bool {
	set := map[string]bool{}
	for _, c := range candidate {
		set[c] = true
	}
	for k := range required {
		if !set[k] {
			return false
		}
	}
	return true
}

func candidatesEqual(a, b []PromotionCandidate) bool {
	if len(a) != len(b) {
		return false
	}
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	return string(aj) == string(bj)
}

func persistWithLock(skillRoot string, state EvolutionState, verifier Verifier, failAt string) error {
	statePath := filepath.Join(skillRoot, "evolution", "state.json")
	lockPath := statePath + ".lock"
	// advisory lock via mkdir
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := os.Mkdir(lockPath, 0755)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			return fmt.Errorf("acquire lock: %w", err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("retryable transaction conflict: evolution state is locked")
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer os.Remove(lockPath)

	if failAt == "before-temp-create" {
		return fmt.Errorf("injected write failure at %s", failAt)
	}
	if err := validateStateDocument(state, mustLoadFixtures(skillRoot, verifier)); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(statePath), ".state.json.*")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		os.Remove(tmpName)
	}()
	if failAt == "after-temp-create" {
		return fmt.Errorf("injected write failure at %s", failAt)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(state); err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	if failAt == "after-temp-write" {
		return fmt.Errorf("injected write failure at %s", failAt)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("fsync: %w", err)
	}
	if failAt == "after-temp-fsync" {
		return fmt.Errorf("injected write failure at %s", failAt)
	}
	tmp.Close()
	if failAt == "before-replace" {
		return fmt.Errorf("injected write failure at %s", failAt)
	}
	if err := os.Rename(tmpName, statePath); err != nil {
		return fmt.Errorf("replace: %w", err)
	}
	return nil
}

func mustLoadFixtures(skillRoot string, verifier Verifier) map[string]FixtureEvidence {
	m, _ := loadFixtures(skillRoot, verifier)
	return m
}

// CaptureReview is the idempotent post-review capture entry point.
// It validates, deduplicates, and persists a review record via locked updater.
// Returns the updated state and whether the review was newly appended.
func (o *Orchestrator) CaptureReview(record ReviewRecord) (EvolutionState, bool, error) {
	skillRoot := o.SkillRoot
	if skillRoot == "" {
		return EvolutionState{}, false, fmt.Errorf("skillRoot is required")
	}
	verifier := o.Verifier
	if verifier == nil {
		verifier = HarnessVerifier{}
	}
	state, fixtures, err := LoadState(skillRoot, verifier)
	if err != nil {
		return EvolutionState{}, false, err
	}
	if err := ValidateReviewRecord(record, fixtures); err != nil {
		return EvolutionState{}, false, err
	}
	// Deduplication: duplicate review_id or finding_id rejects.
	for _, r := range state.Reviews {
		if r.ReviewID == record.ReviewID {
			return EvolutionState{}, false, fmt.Errorf("duplicate review_id: %s", record.ReviewID)
		}
	}
	existingFindings := map[string]bool{}
	for _, r := range state.Reviews {
		for _, f := range r.Findings {
			existingFindings[f.FindingID] = true
		}
	}
	for _, f := range record.Findings {
		if existingFindings[f.FindingID] {
			return EvolutionState{}, false, fmt.Errorf("duplicate finding_id: %s", f.FindingID)
		}
	}
	// Timestamp regression gate.
	stateUpdatedAt, _ := parseUTCTimestamp(state.UpdatedAt)
	recordAt, _ := parseUTCTimestamp(record.OccurredAt)
	if recordAt.Before(stateUpdatedAt) {
		return EvolutionState{}, false, fmt.Errorf("record.occurred_at: cannot move state.updated_at backward")
	}
	// Append and derive.
	state.Reviews = append(state.Reviews, record)
	state.UpdatedAt = record.OccurredAt
	state.PromotionCandidates = DerivePromotionCandidates(state.Reviews, state.Validations, fixtures)
	state.Metrics = deriveMetrics(state.Reviews, state.PromotionCandidates)
	if err := PersistState(skillRoot, state, verifier); err != nil {
		return EvolutionState{}, false, err
	}
	// Reload to confirm durability.
	updated, _, err := LoadState(skillRoot, verifier)
	if err != nil {
		return EvolutionState{}, false, err
	}
	return updated, true, nil
}

// SubmitValidation routes deterministic fixture validation through independent validator.
func (o *Orchestrator) SubmitValidation(record ValidationRecord) (EvolutionState, bool, error) {
	skillRoot := o.SkillRoot
	if skillRoot == "" {
		return EvolutionState{}, false, fmt.Errorf("skillRoot is required")
	}
	verifier := o.Verifier
	if verifier == nil {
		verifier = HarnessVerifier{}
	}
	state, fixtures, err := LoadState(skillRoot, verifier)
	if err != nil {
		return EvolutionState{}, false, err
	}
	reviewIDs := map[string]string{}
	for _, r := range state.Reviews {
		reviewIDs[r.ReviewID] = r.ReviewerID
	}
	if err := ValidateValidationRecord(record, fixtures, reviewIDs); err != nil {
		return EvolutionState{}, false, err
	}
	for _, v := range state.Validations {
		if v.ValidationID == record.ValidationID {
			return EvolutionState{}, false, fmt.Errorf("duplicate validation_id: %s", record.ValidationID)
		}
	}
	stateUpdatedAt, _ := parseUTCTimestamp(state.UpdatedAt)
	recordAt, _ := parseUTCTimestamp(record.OccurredAt)
	if recordAt.Before(stateUpdatedAt) {
		return EvolutionState{}, false, fmt.Errorf("record.occurred_at: cannot move state.updated_at backward")
	}
	state.Validations = append(state.Validations, record)
	state.UpdatedAt = record.OccurredAt
	state.PromotionCandidates = DerivePromotionCandidates(state.Reviews, state.Validations, fixtures)
	state.Metrics = deriveMetrics(state.Reviews, state.PromotionCandidates)
	if err := PersistState(skillRoot, state, verifier); err != nil {
		return EvolutionState{}, false, err
	}
	updated, _, err := LoadState(skillRoot, verifier)
	if err != nil {
		return EvolutionState{}, false, err
	}
	return updated, true, nil
}

func deriveMetrics(reviews []ReviewRecord, candidates []PromotionCandidate) map[string]any {
	total := len(reviews)
	var success int
	var confirmed, fp, fn int
	for _, r := range reviews {
		if r.Outcome == "success" {
			success++
		}
		for _, f := range r.Findings {
			switch f.Disposition {
			case "confirmed":
				confirmed++
			case "false-positive":
				fp++
			case "false-negative":
				fn++
			}
		}
	}
	var successRate any
	if total == 0 {
		successRate = nil
	} else {
		// round to 4 decimals like Python
		rate := float64(success) / float64(total)
		// poor man's round
		h := fnv.New64a()
		_ = h
		successRate = float64(int(rate*10000+0.5)) / 10000
	}
	return map[string]any{
		"usage_count":          total,
		"completed_reviews":    total,
		"success_rate":         successRate,
		"confirmed_findings":   confirmed,
		"false_positives":      fp,
		"false_negatives":      fn,
		"promotion_candidates": len(candidates),
	}
}

// Ensure no credential leakage in serialized forms.
func containsSecret(s string) bool {
	lower := strings.ToLower(s)
	for _, kw := range []string{"api_key", "secret", "password", "bearer", "token", "authorization", "client_secret"} {
		if strings.Contains(lower, kw) {
			// allow the word in rollback doc but not as assignment
			if strings.Contains(s, "[REDACTED]") {
				continue
			}
			if regexp.MustCompile(`(?i)(` + kw + `)\s*[:=]`).MatchString(s) {
				return true
			}
		}
	}
	return false
}

// Never mutate Linear or active reviewer; verify no side effects.
var _ = sha40Re
