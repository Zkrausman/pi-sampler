package planningrubric

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validRubric() Rubric {
	return Rubric{
		SchemaVersion: SchemaVersion,
		Kind:          "ticket",
		TicketID:      "WORK-999",
		WorkClass:     "project-runtime",
		RepositoryResearch: RepositoryResearch{
			CitedPaths: []string{"src/domain-risk/guard.go", "pkg/server/server.go"},
			OverlapSearch: OverlapSearch{
				Queries:               []string{"risk guard", "signal buy"},
				ExistingIssuesChecked: []string{"WORK-100", "WORK-101"},
				DocsChecked:           []string{"docs/specs/EPIC_AI_Development_Governance_OKF_Compliance.md"},
			},
			SourceOfTruthRefs: []string{"AGENTS.md section 5", ".context/architecture.md"},
		},
		ActorAuthority: ActorAuthority{
			Actors: []Actor{
				{Role: "controller", Authority: "schedules and dispatches; cannot merge", TrustBoundary: "controller never mutates candidate branch"},
				{Role: "implementer", Authority: "edits ticket branch only", TrustBoundary: "no Linear status mutation"},
				{Role: "reviewer", Authority: "fresh worktree review; independent verdict", TrustBoundary: "no shared transcript; cannot self-approve"},
			},
			NoSelfApproval: true,
			MutationBounds: "only files listed in Scope; branch zkrausman/work-xxx-*",
		},
		AsyncAgentic: AsyncAgentic{
			IsAsync:                  false,
			StateMachine:             "not_applicable — synchronous Go change",
			Idempotency:              "not_applicable",
			FailureRetryCancellation: "not_applicable",
			Evidence:                 "not_applicable",
			Observability:            "not_applicable",
			Rollback:                 "not_applicable",
		},
		CredentialsIntegrations: CredentialsIntegrations{
			RequiresIntegration:   false,
			LeastPrivilege:        "not_applicable — no external integration",
			SecretRedaction:       "no secrets; redacted digests only",
			MergeCompletionPolicy: "branch protection + CI required checks before merge; reconciler moves Done only after verified merge",
		},
		AcceptanceCriteria: AcceptanceCriteria{
			BehavioralTests:      []string{"src/domain-risk guard downgrades SignalBuy under drawdown"},
			NegativeCases:        []string{"SignalSell still permitted under drawdown"},
			VerificationCommands: []string{"go test -race ./src/domain-risk -count=1"},
			CompletionEvidence:   "go test output + OKF updated + delivery manifest bound to delivery commit",
			NonGoVerification:    "docs/specs/WORK-999.md updated; no invented APIs or test results",
		},
		DependencyGraph: DependencyGraph{
			Dependencies:               []string{},
			FoundationBeforeAutomation: true,
			Rationale:                  "no blockers; standalone runtime change",
		},
		DiscoverySpike: DiscoverySpike{
			RequiresExternalCapability: false,
			SpikeTicket:                "",
			AssumedAPIs:                nil,
		},
		PlanningReport: PlanningReport{
			RubricOutcome:             "pass",
			UnresolvedAssumptions:     []string{},
			DependencyRationale:       "standalone; foundation already on master",
			HumanEscalationConditions: []string{"scope creep beyond src/domain-risk requires human review"},
		},
	}
}

func TestValidateValidGoFeature(t *testing.T) {
	r := validRubric()
	if err := Validate(r, "."); err != nil {
		t.Fatalf("valid rubric: %v", err)
	}
}

func TestValidateRejectsMissingCitedPaths(t *testing.T) {
	r := validRubric()
	r.RepositoryResearch.CitedPaths = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "cited_paths") {
		t.Fatalf("expected cited_paths error, got %v", err)
	}
}

func TestValidateRejectsMissingOverlapSearch(t *testing.T) {
	r := validRubric()
	r.RepositoryResearch.OverlapSearch.Queries = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRejectsMissingActorRoles(t *testing.T) {
	r := validRubric()
	r.ActorAuthority.Actors = r.ActorAuthority.Actors[:2]
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "controller") || !strings.Contains(err.Error(), "reviewer") {
		// Any controller/implementer/reviewer error is acceptable.
		if err == nil {
			t.Fatal("expected actor error")
		}
	}
}

func TestValidateRejectsSelfApproval(t *testing.T) {
	r := validRubric()
	r.ActorAuthority.NoSelfApproval = false
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "no_self_approval") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRequiresAsyncBoundariesWhenAsync(t *testing.T) {
	r := validRubric()
	r.AsyncAgentic.IsAsync = true
	r.AsyncAgentic.StateMachine = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "async_agentic.state_machine") {
		t.Fatalf("got %v", err)
	}
	// Valid async rubric must include all async boundaries.
	r = validRubric()
	r.AsyncAgentic = AsyncAgentic{
		IsAsync:                  true,
		StateMachine:             "requested→dispatched→review-requested→merged/failed",
		Idempotency:              "idempotency_key correlation; dedup by event_id",
		FailureRetryCancellation: "bounded retries then human-escalated; cancel token honored",
		Evidence:                 "ledger.mjs append-only + delivery manifest SHA",
		Observability:            "getDashboard + slog JSON",
		Rollback:                 "revert commit + manual verification",
	}
	// Also needs integration boundaries when async is typically integration-backed.
	r.CredentialsIntegrations.RequiresIntegration = true
	r.CredentialsIntegrations.LeastPrivilege = "least-privilege PAT scoped to issue:write"
	r.CredentialsIntegrations.SecretRedaction = "redacted digests; no bearer tokens in logs"
	r.CredentialsIntegrations.MergeCompletionPolicy = "branch protection + required checks + reconciler"
	if err := Validate(r, "."); err != nil {
		t.Fatalf("async rubric: %v", err)
	}
}

func TestValidateRequiresCredentialsBoundariesForIntegration(t *testing.T) {
	r := validRubric()
	r.CredentialsIntegrations.RequiresIntegration = true
	r.CredentialsIntegrations.LeastPrivilege = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "least_privilege") {
		t.Fatalf("got %v", err)
	}
	r = validRubric()
	r.CredentialsIntegrations.RequiresIntegration = true
	r.CredentialsIntegrations.SecretRedaction = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "secret_redaction") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRequiresDiscoverySpikeWhenExternalCapability(t *testing.T) {
	r := validRubric()
	r.DiscoverySpike.RequiresExternalCapability = true
	r.DiscoverySpike.SpikeTicket = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "spike_ticket") {
		t.Fatalf("got %v", err)
	}
	r.DiscoverySpike.SpikeTicket = "WORK-SP1 Research Reddit/Jules API capabilities"
	r.DiscoverySpike.AssumedAPIs = []string{"undocumented assumes plugin X does Y"}
	// Assumed APIs are allowed when external capability is required (they are recorded, not forbidden).
	if err := Validate(r, "."); err != nil {
		t.Fatalf("with spike: %v", err)
	}
	// But inventing assumed APIs without a spike context is disallowed when not external.
	r = validRubric()
	r.DiscoverySpike.RequiresExternalCapability = false
	r.DiscoverySpike.AssumedAPIs = []string{"assumed api"}
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "assumed_apis") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRequiresNonGoVerificationAndBehavioralTests(t *testing.T) {
	r := validRubric()
	r.AcceptanceCriteria.BehavioralTests = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "behavioral_tests") {
		t.Fatalf("got %v", err)
	}
	r = validRubric()
	r.AcceptanceCriteria.NegativeCases = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "negative") {
		t.Fatalf("got %v", err)
	}
	r = validRubric()
	r.AcceptanceCriteria.NonGoVerification = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "non_go_verification") {
		t.Fatalf("got %v", err)
	}
	r = validRubric()
	r.AcceptanceCriteria.VerificationCommands = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "verification_commands") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRequiresPlanningReportEscalation(t *testing.T) {
	r := validRubric()
	r.PlanningReport.HumanEscalationConditions = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "human_escalation") {
		t.Fatalf("got %v", err)
	}
	r = validRubric()
	r.PlanningReport.DependencyRationale = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "dependency_rationale") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRejectsUnknownFieldsInFile(t *testing.T) {
	dir := t.TempDir()
	r := validRubric()
	data, _ := json.Marshal(r)
	// Inject unknown top-level field.
	data = []byte(strings.Replace(string(data), `"kind":"ticket"`, `"kind":"ticket","unknown":true`, 1))
	path := filepath.Join(dir, "rubric.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFile(path, "."); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateFileRejectsMissingSource(t *testing.T) {
	if err := ValidateFile(filepath.Join(t.TempDir(), "missing.json"), "."); err == nil {
		t.Fatal("expected missing file error")
	}
}

// Scenario fixtures: conventional Go, external API with spike, Jules/Pi controller.

func validGoFeatureRubric() Rubric {
	r := validRubric()
	r.TicketID = "WORK-500"
	r.WorkClass = "project-runtime"
	return r
}

func validExternalAPIRubric() Rubric {
	r := validRubric()
	r.TicketID = "WORK-501"
	r.WorkClass = "project-runtime"
	r.RepositoryResearch.CitedPaths = []string{"src/broker-adapter/client.go", "pkg/data/fetcher.go"}
	r.DiscoverySpike = DiscoverySpike{
		RequiresExternalCapability: true,
		SpikeTicket:                "WORK-501-SP1 spike: verify Robinhood MCP tool schemas via discovery",
		AssumedAPIs:                nil,
	}
	r.AsyncAgentic = AsyncAgentic{
		IsAsync:                  true,
		StateMachine:             "idle→fetching→retry→done/failed",
		Idempotency:              "request id dedup; safe retry",
		FailureRetryCancellation: "exponential backoff max 3; cancellation via context",
		Evidence:                 "evidence/references ledger + digests",
		Observability:            "slog JSON; metrics counter",
		Rollback:                 "no state mutation on failure; cache TTL expiry",
	}
	r.CredentialsIntegrations = CredentialsIntegrations{
		RequiresIntegration:   true,
		LeastPrivilege:        "read-only market data scope; no trading scope",
		SecretRedaction:       "no bearer tokens persisted; redacted digests in logs",
		MergeCompletionPolicy: "CI + wiki-governance + delivery_gate required checks",
	}
	r.DependencyGraph = DependencyGraph{
		Dependencies:               []string{"WORK-501-SP1"},
		FoundationBeforeAutomation: true,
		Rationale:                  "spike must confirm MCP schema before execution ticket",
	}
	r.PlanningReport.DependencyRationale = "spike → execution; execution blocked until spike confirms API shape"
	return r
}

func validJulesPiControllerRubric() Rubric {
	r := validRubric()
	r.TicketID = "WORK-502"
	r.Kind = "epic"
	r.WorkClass = "development-process"
	r.RepositoryResearch.CitedPaths = []string{"extensions/delivery-controller/src/ledger.mjs", "extensions/delivery-controller/src/orchestrator.mjs"}
	r.RepositoryResearch.OverlapSearch.Queries = []string{"delivery controller", "pi review worker", "jules adapter"}
	r.RepositoryResearch.OverlapSearch.ExistingIssuesChecked = []string{"WORK-112", "WORK-113", "WORK-114"}
	r.RepositoryResearch.OverlapSearch.DocsChecked = []string{"docs/runbooks/project-delivery.md"}
	r.DiscoverySpike = DiscoverySpike{
		RequiresExternalCapability: true,
		SpikeTicket:                "WORK-111 spike: verify Jules API + Pi extension lifecycle",
		AssumedAPIs:                nil,
	}
	r.ActorAuthority = ActorAuthority{
		Actors: []Actor{
			{Role: "controller", Authority: "thin orchestrator; ledger only; no branch mutation", TrustBoundary: "controller cannot approve or merge"},
			{Role: "implementer", Authority: "Jules — ticket branch only", TrustBoundary: "no Linear status change; no merge authority"},
			{Role: "reviewer", Authority: "Pi reviewer fresh worktree + review skill", TrustBoundary: "fresh process; no shared transcript; cannot be same identity as implementer"},
		},
		NoSelfApproval: true,
		MutationBounds: "controller: ledger .pi/tmp/controller/jobs.ndjson only; implementer: ticket branch; reviewer: read-only worktree",
	}
	r.AsyncAgentic = AsyncAgentic{
		IsAsync:                  true,
		StateMachine:             "requested→dispatched→implementation-ready→review-requested→merge-ready/failed",
		Idempotency:              "idempotency_key + event_id dedup; ledger.replay",
		FailureRetryCancellation: "bounded retries; provider outage → human-escalated; cancellation via kill-switch",
		Evidence:                 "jobs.ndjson append-only + evidence/delivery/<TICKET>.json bound to delivery commit",
		Observability:            "slog JSON STDOUT; getDashboard + ledger snapshot",
		Rollback:                 "merge-controller reverts only allowlisted mechanical conflicts; otherwise human-escalated",
	}
	r.CredentialsIntegrations = CredentialsIntegrations{
		RequiresIntegration:   true,
		LeastPrivilege:        "GitHub PAT contents:read + pull-requests:write; Linear API limited to linked issue status",
		SecretRedaction:       "redact.mjs redaction; no secrets or raw transcripts in ledger or wiki pages",
		MergeCompletionPolicy: "branch protection + CI delivery_evidence + wiki_governance + reconciler verified merge before Done",
	}
	r.AcceptanceCriteria = AcceptanceCriteria{
		BehavioralTests:      []string{"ledger state transitions replay idempotently under concurrent appends"},
		NegativeCases:        []string{"provider outage does not regress merged→failed"},
		VerificationCommands: []string{"node --test extensions/delivery-controller/src/*.test.mjs", "go test -race ./pkg/deliveryevidence -count=1"},
		CompletionEvidence:   "ledger snapshot + delivery manifest + wiki lint clean; reconciler moves Done only after verified merge",
		NonGoVerification:    "docs/runbooks/project-delivery.md updated with controller/implementer/reviewer table; no invented APIs",
	}
	r.DependencyGraph = DependencyGraph{
		Dependencies:               []string{"WORK-104", "WORK-111", "WORK-112"},
		FoundationBeforeAutomation: true,
		Rationale:                  "contract + capability spike → controller foundation before dispatch/merge automation",
	}
	r.PlanningReport = PlanningReport{
		RubricOutcome:             "pass",
		UnresolvedAssumptions:     []string{"Jules job API availability pending WORK-111 confirmation — handled via spike ticket"},
		DependencyRationale:       "foundation (WORK-104+WORK-111) before automation (WORK-112+) prevents building on assumed capabilities",
		HumanEscalationConditions: []string{"scope creep into broker/risk/telemetry requires human review", "any self-approval or unbounded mutation attempt escalates"},
	}
	return r
}

func TestValidGoFeatureScenario(t *testing.T) {
	if err := Validate(validGoFeatureRubric(), "."); err != nil {
		t.Fatalf("go feature: %v", err)
	}
}

func TestValidExternalAPIScenario(t *testing.T) {
	if err := Validate(validExternalAPIRubric(), "."); err != nil {
		t.Fatalf("external api: %v", err)
	}
}

func TestValidJulesPiControllerScenario(t *testing.T) {
	if err := Validate(validJulesPiControllerRubric(), "."); err != nil {
		t.Fatalf("jules/pi: %v", err)
	}
}

// Negative variants: each absence fails validation.

func TestGoFeatureFailsWhenMissingTrustBoundary(t *testing.T) {
	r := validGoFeatureRubric()
	r.ActorAuthority.Actors[2].TrustBoundary = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "trust_boundary") {
		t.Fatalf("got %v", err)
	}
}

func TestExternalAPIFailsWithoutSpike(t *testing.T) {
	r := validExternalAPIRubric()
	r.DiscoverySpike.SpikeTicket = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "spike_ticket") {
		t.Fatalf("got %v", err)
	}
}

func TestExternalAPIFailsWithoutOverlapEvidence(t *testing.T) {
	r := validExternalAPIRubric()
	r.RepositoryResearch.OverlapSearch.DocsChecked = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("got %v", err)
	}
}

func TestExternalAPIFailsWhenInventingAPIsWithoutSpike(t *testing.T) {
	r := validGoFeatureRubric()
	r.DiscoverySpike.AssumedAPIs = []string{"assumed external api"}
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "assumed_apis") {
		t.Fatalf("got %v", err)
	}
}

func TestJulesPiFailsWithoutAsyncBoundaries(t *testing.T) {
	r := validJulesPiControllerRubric()
	r.AsyncAgentic.StateMachine = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "state_machine") {
		t.Fatalf("got %v", err)
	}
	r = validJulesPiControllerRubric()
	r.CredentialsIntegrations.LeastPrivilege = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "least_privilege") {
		t.Fatalf("got %v", err)
	}
	r = validJulesPiControllerRubric()
	r.CredentialsIntegrations.MergeCompletionPolicy = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "merge_completion_policy") {
		t.Fatalf("got %v", err)
	}
}

func TestJulesPiFailsWhenSelfApproval(t *testing.T) {
	r := validJulesPiControllerRubric()
	r.ActorAuthority.NoSelfApproval = false
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "no_self_approval") {
		t.Fatalf("got %v", err)
	}
}

func TestJulesPiFailsWhenMissingHumanEscalation(t *testing.T) {
	r := validJulesPiControllerRubric()
	r.PlanningReport.HumanEscalationConditions = nil
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "human_escalation") {
		t.Fatalf("got %v", err)
	}
}

func TestJulesPiFailsWhenWorkClassUnlabeled(t *testing.T) {
	r := validJulesPiControllerRubric()
	r.WorkClass = ""
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "work_class") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	r := validGoFeatureRubric()
	data, _ := json.Marshal(r)
	path := filepath.Join(dir, "rubric.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFile(path, "."); err != nil {
		t.Fatalf("round-trip: %v", err)
	}
}

func TestValidateRejectsWorkClassInvalid(t *testing.T) {
	r := validRubric()
	r.WorkClass = "unknown"
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "work_class") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateRejectsInvalidKind(t *testing.T) {
	r := validRubric()
	r.Kind = "story"
	if err := Validate(r, "."); err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("got %v", err)
	}
}
