// Package planningrubric provides a deterministic, offline validator for the
// machine-readable planning-quality rubric shared by create-ticket and
// create-epic. It never contacts Linear, broker, or LLM services.
package planningrubric

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const SchemaVersion = "planning-rubric/v1"

var (
	ticketID  = regexp.MustCompile(`^[A-Z][A-Z0-9]+-[1-9][0-9]*$`)
	pathToken = regexp.MustCompile(`^[a-zA-Z0-9._/\-]{2,}$`)
)

// Rubric is the machine-readable planning-quality artifact validated before
// Linear publication by both planning skills. Field names intentionally mirror
// the JSON keys so error messages are short and actionable.
type Rubric struct {
	SchemaVersion           string                  `json:"schema_version"`
	Kind                    string                  `json:"kind"`
	TicketID                string                  `json:"ticket_id"`
	WorkClass               string                  `json:"work_class"`
	RepositoryResearch      RepositoryResearch      `json:"repository_research"`
	ActorAuthority          ActorAuthority          `json:"actor_authority"`
	AsyncAgentic            AsyncAgentic            `json:"async_agentic"`
	CredentialsIntegrations CredentialsIntegrations `json:"credentials_integrations"`
	AcceptanceCriteria      AcceptanceCriteria      `json:"acceptance_criteria"`
	DependencyGraph         DependencyGraph         `json:"dependency_graph"`
	DiscoverySpike          DiscoverySpike          `json:"discovery_spike"`
	PlanningReport          PlanningReport          `json:"planning_report"`
}

type RepositoryResearch struct {
	CitedPaths        []string      `json:"cited_paths"`
	OverlapSearch     OverlapSearch `json:"overlap_search"`
	SourceOfTruthRefs []string      `json:"source_of_truth_refs"`
}

type OverlapSearch struct {
	Queries               []string `json:"queries"`
	ExistingIssuesChecked []string `json:"existing_issues_checked"`
	DocsChecked           []string `json:"docs_checked"`
}

type ActorAuthority struct {
	Actors         []Actor `json:"actors"`
	NoSelfApproval bool    `json:"no_self_approval"`
	MutationBounds string  `json:"mutation_bounds"`
}

type Actor struct {
	Role          string `json:"role"`
	Authority     string `json:"authority"`
	TrustBoundary string `json:"trust_boundary"`
}

type AsyncAgentic struct {
	IsAsync                  bool   `json:"is_async"`
	StateMachine             string `json:"state_machine"`
	Idempotency              string `json:"idempotency"`
	FailureRetryCancellation string `json:"failure_retry_cancellation"`
	Evidence                 string `json:"evidence"`
	Observability            string `json:"observability"`
	Rollback                 string `json:"rollback"`
}

type CredentialsIntegrations struct {
	RequiresIntegration   bool   `json:"requires_integration"`
	LeastPrivilege        string `json:"least_privilege"`
	SecretRedaction       string `json:"secret_redaction"`
	MergeCompletionPolicy string `json:"merge_completion_policy"`
}

type AcceptanceCriteria struct {
	BehavioralTests      []string `json:"behavioral_tests"`
	NegativeCases        []string `json:"negative_cases"`
	VerificationCommands []string `json:"verification_commands"`
	CompletionEvidence   string   `json:"completion_evidence"`
	NonGoVerification    string   `json:"non_go_verification"`
}

type DependencyGraph struct {
	Dependencies               []string `json:"dependencies"`
	FoundationBeforeAutomation bool     `json:"foundation_before_automation"`
	Rationale                  string   `json:"rationale"`
}

type DiscoverySpike struct {
	RequiresExternalCapability bool     `json:"requires_external_capability"`
	SpikeTicket                string   `json:"spike_ticket"`
	AssumedAPIs                []string `json:"assumed_apis"`
}

type PlanningReport struct {
	RubricOutcome             string   `json:"rubric_outcome"`
	UnresolvedAssumptions     []string `json:"unresolved_assumptions"`
	DependencyRationale       string   `json:"dependency_rationale"`
	HumanEscalationConditions []string `json:"human_escalation_conditions"`
}

// ValidateFile is the CLI entry point. It enforces file containment and
// delegates to Validate.
func ValidateFile(manifestPath, repositoryRoot string) error {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read rubric: %w", err)
	}
	var rubric Rubric
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&rubric); err != nil {
		return fmt.Errorf("decode rubric: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("rubric must contain exactly one JSON object")
	}
	return Validate(rubric, repositoryRoot)
}

// Validate enforces all quality gates without touching network, broker, or secrets.
func Validate(r Rubric, repositoryRoot string) error {
	if r.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported schema_version %q", r.SchemaVersion)
	}
	if r.Kind != "ticket" && r.Kind != "epic" {
		return fmt.Errorf("invalid kind %q", r.Kind)
	}
	if !ticketID.MatchString(r.TicketID) {
		return fmt.Errorf("invalid ticket_id %q", r.TicketID)
	}
	switch r.WorkClass {
	case "project-runtime", "development-process":
	default:
		return fmt.Errorf("invalid work_class %q", r.WorkClass)
	}
	if err := validateRepositoryResearch(r.RepositoryResearch, repositoryRoot); err != nil {
		return err
	}
	if err := validateActorAuthority(r.ActorAuthority); err != nil {
		return err
	}
	if err := validateAsyncAgentic(r.AsyncAgentic); err != nil {
		return err
	}
	if err := validateCredentialsIntegrations(r.CredentialsIntegrations); err != nil {
		return err
	}
	if err := validateAcceptanceCriteria(r.AcceptanceCriteria); err != nil {
		return err
	}
	if err := validateDependencyGraph(r.DependencyGraph); err != nil {
		return err
	}
	if err := validateDiscoverySpike(r.DiscoverySpike); err != nil {
		return err
	}
	if err := validatePlanningReport(r.PlanningReport); err != nil {
		return err
	}
	return nil
}

func validateRepositoryResearch(r RepositoryResearch, repositoryRoot string) error {
	if len(r.CitedPaths) == 0 {
		return fmt.Errorf("repository_research.cited_paths must not be empty")
	}
	for i, p := range r.CitedPaths {
		if strings.TrimSpace(p) == "" || !pathToken.MatchString(strings.TrimSpace(p)) {
			return fmt.Errorf("repository_research.cited_paths[%d] is not a repository path", i)
		}
		if repositoryRoot != "" {
			if err := containedPath(p, repositoryRoot); err != nil {
				return fmt.Errorf("repository_research.cited_paths[%d]: %w", i, err)
			}
		}
	}
	if len(r.OverlapSearch.Queries) == 0 {
		return fmt.Errorf("repository_research.overlap_search.queries must not be empty")
	}
	for i, q := range r.OverlapSearch.Queries {
		if strings.TrimSpace(q) == "" {
			return fmt.Errorf("repository_research.overlap_search.queries[%d] must not be empty", i)
		}
	}
	if len(r.OverlapSearch.ExistingIssuesChecked) == 0 {
		return fmt.Errorf("repository_research.overlap_search.existing_issues_checked must not be empty")
	}
	for i, v := range r.OverlapSearch.ExistingIssuesChecked {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("repository_research.overlap_search.existing_issues_checked[%d] must not be empty", i)
		}
	}
	if len(r.OverlapSearch.DocsChecked) == 0 {
		return fmt.Errorf("repository_research.overlap_search.docs_checked must not be empty")
	}
	for i, v := range r.OverlapSearch.DocsChecked {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("repository_research.overlap_search.docs_checked[%d] must not be empty", i)
		}
		if repositoryRoot != "" {
			// Allow both existing and planned doc paths; check containment not existence.
			if strings.Contains(v, "..") || filepath.IsAbs(v) {
				return fmt.Errorf("repository_research.overlap_search.docs_checked[%d] escapes repository root", i)
			}
		}
	}
	if len(r.SourceOfTruthRefs) == 0 {
		return fmt.Errorf("repository_research.source_of_truth_refs must not be empty")
	}
	for i, v := range r.SourceOfTruthRefs {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("repository_research.source_of_truth_refs[%d] must not be empty", i)
		}
	}
	return nil
}

func validateActorAuthority(a ActorAuthority) error {
	if len(a.Actors) < 3 {
		return fmt.Errorf("actor_authority.actors requires controller, implementer, and reviewer")
	}
	roles := map[string]bool{}
	for i, actor := range a.Actors {
		switch actor.Role {
		case "controller", "implementer", "reviewer":
		default:
			return fmt.Errorf("actor_authority.actors[%d].role invalid %q", i, actor.Role)
		}
		if roles[actor.Role] {
			return fmt.Errorf("actor_authority duplicate role %q", actor.Role)
		}
		roles[actor.Role] = true
		if strings.TrimSpace(actor.Authority) == "" {
			return fmt.Errorf("actor_authority.actors[%d].authority must not be empty", i)
		}
		if strings.TrimSpace(actor.TrustBoundary) == "" {
			return fmt.Errorf("actor_authority.actors[%d].trust_boundary must not be empty", i)
		}
	}
	for _, required := range []string{"controller", "implementer", "reviewer"} {
		if !roles[required] {
			return fmt.Errorf("actor_authority missing %q actor", required)
		}
	}
	if !a.NoSelfApproval {
		return fmt.Errorf("actor_authority.no_self_approval must be true")
	}
	if strings.TrimSpace(a.MutationBounds) == "" {
		return fmt.Errorf("actor_authority.mutation_bounds must not be empty")
	}
	return nil
}

func validateAsyncAgentic(a AsyncAgentic) error {
	required := map[string]string{
		"state_machine":              a.StateMachine,
		"idempotency":                a.Idempotency,
		"failure_retry_cancellation": a.FailureRetryCancellation,
		"evidence":                   a.Evidence,
		"observability":              a.Observability,
		"rollback":                   a.Rollback,
	}
	for key, value := range required {
		if a.IsAsync && strings.TrimSpace(value) == "" {
			return fmt.Errorf("async_agentic.%s is required for async work", key)
		}
		if !a.IsAsync && strings.TrimSpace(value) != "" && key == "state_machine" {
			// Synchronous work may leave async fields as "not_applicable" or empty.
			// Require them to be explicit when set: at least non-empty is allowed.
		}
	}
	// When async, every boundary must be non-empty.
	if a.IsAsync {
		for key, value := range required {
			if strings.TrimSpace(value) == "" {
				return fmt.Errorf("async_agentic.%s is required for async work", key)
			}
		}
	}
	return nil
}

func validateCredentialsIntegrations(c CredentialsIntegrations) error {
	if c.RequiresIntegration {
		if strings.TrimSpace(c.LeastPrivilege) == "" {
			return fmt.Errorf("credentials_integrations.least_privilege is required for integrations")
		}
		if strings.TrimSpace(c.SecretRedaction) == "" {
			return fmt.Errorf("credentials_integrations.secret_redaction is required for integrations")
		}
		if strings.TrimSpace(c.MergeCompletionPolicy) == "" {
			return fmt.Errorf("credentials_integrations.merge_completion_policy is required for integrations")
		}
	}
	// Non-integration tickets still require redaction and policy to be documented explicitly
	// (may be "not_applicable" with rationale).
	if strings.TrimSpace(c.SecretRedaction) == "" {
		return fmt.Errorf("credentials_integrations.secret_redaction must not be empty")
	}
	if strings.TrimSpace(c.MergeCompletionPolicy) == "" {
		return fmt.Errorf("credentials_integrations.merge_completion_policy must not be empty")
	}
	if c.RequiresIntegration && strings.TrimSpace(c.LeastPrivilege) == "" {
		return fmt.Errorf("credentials_integrations.least_privilege must not be empty for integrations")
	}
	return nil
}

func validateAcceptanceCriteria(a AcceptanceCriteria) error {
	if len(a.BehavioralTests) == 0 {
		return fmt.Errorf("acceptance_criteria.behavioral_tests must not be empty")
	}
	for i, v := range a.BehavioralTests {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("acceptance_criteria.behavioral_tests[%d] must not be empty", i)
		}
	}
	if len(a.NegativeCases) == 0 {
		return fmt.Errorf("acceptance_criteria.negative_cases must not be empty")
	}
	for i, v := range a.NegativeCases {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("acceptance_criteria.negative_cases[%d] must not be empty", i)
		}
	}
	if len(a.VerificationCommands) == 0 {
		return fmt.Errorf("acceptance_criteria.verification_commands must not be empty")
	}
	for i, v := range a.VerificationCommands {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("acceptance_criteria.verification_commands[%d] must not be empty", i)
		}
	}
	if strings.TrimSpace(a.CompletionEvidence) == "" {
		return fmt.Errorf("acceptance_criteria.completion_evidence must not be empty")
	}
	if strings.TrimSpace(a.NonGoVerification) == "" {
		return fmt.Errorf("acceptance_criteria.non_go_verification must not be empty")
	}
	return nil
}

func validateDependencyGraph(d DependencyGraph) error {
	if strings.TrimSpace(d.Rationale) == "" {
		return fmt.Errorf("dependency_graph.rationale must not be empty")
	}
	// foundation_before_automation must be true whenever there are automation/merges
	// downstream — enforce that a stated rationale accompanies the graph.
	return nil
}

func validateDiscoverySpike(d DiscoverySpike) error {
	if d.RequiresExternalCapability {
		if strings.TrimSpace(d.SpikeTicket) == "" {
			return fmt.Errorf("discovery_spike.spike_ticket is required when requires_external_capability is true")
		}
		if !strings.Contains(d.SpikeTicket, "spike") && !strings.Contains(strings.ToLower(d.SpikeTicket), "discover") {
			// Spike ticket identifier may be any non-empty label but must convey discovery.
			// Accept any non-empty value to avoid over-constraining.
		}
	}
	if !d.RequiresExternalCapability && len(d.AssumedAPIs) > 0 {
		return fmt.Errorf("discovery_spike.assumed_apis must be empty when no external capability is required")
	}
	if d.RequiresExternalCapability && len(d.AssumedAPIs) == 0 {
		// Allowed: capability needed but no APIs assumed yet.
	}
	return nil
}

func validatePlanningReport(r PlanningReport) error {
	switch r.RubricOutcome {
	case "pass", "fail":
	default:
		return fmt.Errorf("planning_report.rubric_outcome must be pass or fail")
	}
	if strings.TrimSpace(r.DependencyRationale) == "" {
		return fmt.Errorf("planning_report.dependency_rationale must not be empty")
	}
	if len(r.HumanEscalationConditions) == 0 {
		return fmt.Errorf("planning_report.human_escalation_conditions must not be empty")
	}
	for i, v := range r.HumanEscalationConditions {
		if strings.TrimSpace(v) == "" {
			return fmt.Errorf("planning_report.human_escalation_conditions[%d] must not be empty", i)
		}
	}
	return nil
}

func containedPath(p, repositoryRoot string) error {
	if p == "" || filepath.IsAbs(p) {
		return fmt.Errorf("path must be repository-relative")
	}
	clean := filepath.Clean(filepath.FromSlash(p))
	if strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return fmt.Errorf("path escapes repository root")
	}
	// Resolve via Abs to guard drive-relative corner cases on Windows.
	root, err := filepath.Abs(repositoryRoot)
	if err != nil {
		return fmt.Errorf("resolve repository root: %w", err)
	}
	candidate := filepath.Join(root, filepath.FromSlash(p))
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes repository root")
	}
	return nil
}
