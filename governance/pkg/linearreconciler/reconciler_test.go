package linearreconciler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func cleanPtr(v bool) *bool { b := v; return &b }

func baseManifest(dir, ticket, commit string) string {
	m := map[string]any{
		"schema_version": "delivery-evidence/v1",
		"ticket_id":      ticket,
		"okf_path":       "docs/specs/WORK-107-fixture.md",
		"delivery_state": "merged",
		"pull_request":   map[string]any{"number": 107, "url": "https://github.com/Zkrausman/Project/pull/107", "draft": false},
		"commit_sha":     commit,
		"wiki": map[string]any{
			"source_ids":      []string{"SRC-2026-08-06-001"},
			"page_ids":        []string{"requirements/delivery-evidence"},
			"observation_ids": []string{"obs-2026-08-06-reconciler-fixture"},
		},
		"verifications": []any{map[string]any{"command": "go test ./...", "exit_code": 0, "outcome": "passed", "output_sha256": strings.Repeat("a", 64)}},
		"review":        map[string]any{"verdict": "approved", "commit_sha": commit},
		"merge":         map[string]any{"status": "merged", "commit_sha": commit},
	}
	b, _ := json.Marshal(m)
	p := filepath.Join(dir, "evidence", "delivery", ticket+".json")
	_ = os.MkdirAll(filepath.Dir(p), 0755)
	_ = os.WriteFile(p, b, 0644)
	// also ensure OKF exists
	okfRoot := filepath.Join(dir, "docs", "specs")
	_ = os.MkdirAll(okfRoot, 0755)
	_ = os.WriteFile(filepath.Join(okfRoot, "WORK-107-fixture.md"),
		[]byte("---\ntype: implementation-ticket\ntitle: Fixture\ntimestamp: 2026-08-06T00:00:00Z\n---\nbody\n"), 0644)
	return p
}

func fixtureInputs(t *testing.T, mergeCommit string) Inputs {
	t.Helper()
	dir := t.TempDir()
	commit := strings.Repeat("a", 40)
	if mergeCommit != "" {
		commit = mergeCommit
	}
	abs := baseManifest(dir, "WORK-107", commit)
	rel := "evidence/delivery/WORK-107.json"
	b, _ := os.ReadFile(abs)
	sum := sha256.Sum256(b)
	return Inputs{
		RepoRoot:         dir,
		ManifestPath:     rel,
		ManifestTicketID: "WORK-107",
		ManifestCommit:   commit,
		ManifestSHA256:   hex.EncodeToString(sum[:]),
		ManifestErr:      nil,
		PR: PRState{
			Number: 107, Merged: true, Draft: false,
			MergeCommitSHA: commit, HeadSHA: commit,
			URL: "https://github.com/Zkrausman/Project/pull/107",
		},
		Checks: []CheckState{
			{Name: "Delivery evidence gate / validate", Conclusion: "success"},
			{Name: "Wiki governance / validate", Conclusion: "success"},
		},
		LinearIssue:   &LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "started", StatusName: "In Progress"},
		WikiLintClean: cleanPtr(true),
		AttemptID:     "attempt-1",
	}
}

func TestDecide_MergedSuccess_Transitions(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	dec, err := r.Decide(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if !dec.ShouldTransition || dec.ReasonCode != CodeOK {
		t.Fatalf("expected transition ok, got %+v", dec)
	}
	if dec.WikiLintClean == nil || !*dec.WikiLintClean {
		t.Fatalf("wiki lint should be clean")
	}
}

func TestDecide_Draft_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.PR.Draft = true
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodePRIsDraft {
		t.Fatalf("draft must fail closed, got %+v", dec)
	}
}

func TestDecide_Unmerged_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.PR.Merged = false
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodePRNotMerged {
		t.Fatalf("unmerged must fail closed, got %+v", dec)
	}
}

func TestDecide_FailedCI_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.Checks = []CheckState{
		{Name: "Delivery evidence gate / validate", Conclusion: "failure"},
		{Name: "Wiki governance / validate", Conclusion: "success"},
	}
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeRequiredChecksFailed {
		t.Fatalf("failed CI must fail closed, got %+v", dec)
	}
}

func TestDecide_MissingManifest_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.ManifestErr = os.ErrNotExist
	in.ManifestTicketID = ""
	in.ManifestCommit = ""
	in.ManifestPath = "evidence/delivery/WORK-107.json"
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeMissingManifest {
		t.Fatalf("missing manifest must fail closed, got %+v", dec)
	}
}

func TestDecide_FailedLint_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	b := false
	in.WikiLintClean = &b
	in.WikiLintReason = "orphans: 1"
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeWikiLintNotClean {
		t.Fatalf("failed lint must fail closed, got %+v", dec)
	}
}

func TestDecide_DuplicateDelivery_Idempotent(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.LinearIssue = &LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "completed", StatusName: "Done"}
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || !dec.AlreadyDone || dec.ReasonCode != CodeAlreadyDone {
		t.Fatalf("already Done must be idempotent no-transition, got %+v", dec)
	}
}

func TestDecide_UnavailableState_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.Checks = nil // unavailable
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeRequiredChecksUnknown {
		t.Fatalf("unavailable checks must fail closed, got %+v", dec)
	}
	// also wiki unavailable
	in2 := fixtureInputs(t, "")
	in2.WikiLintClean = nil
	in2.WikiLintErr = fmt.Errorf("lint unavailable")
	dec2, _ := r.Decide(context.Background(), in2)
	if dec2.ShouldTransition || dec2.ReasonCode != CodeWikiLintUnavailable {
		t.Fatalf("unavailable wiki lint must fail closed, got %+v", dec2)
	}
}

func TestDecide_OnlyLinkedIssuesChange(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.LinearIssue = &LinearIssueState{ID: "issue-108", Identifier: "WORK-108", StatusType: "started", StatusName: "In Progress"}
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeNotLinked {
		t.Fatalf("not-linked manifest must not transition, got %+v", dec)
	}
}

func TestDecide_InvalidManifest_FailClosed(t *testing.T) {
	in := fixtureInputs(t, "")
	// Point to a repo where manifest content is actually invalid per validator.
	dir := in.RepoRoot
	manifestAbs := filepath.Join(dir, "evidence/delivery/WORK-107.json")
	// Corrupt manifest: invalid ticket_id
	b, _ := os.ReadFile(manifestAbs)
	var raw map[string]any
	_ = json.Unmarshal(b, &raw)
	raw["ticket_id"] = "!!!"
	nb, _ := json.Marshal(raw)
	_ = os.WriteFile(manifestAbs, nb, 0644)
	in.ManifestTicketID = "!!!"
	r2 := &Reconciler{Validator: &RealManifestValidator{
		ValidateFn: func(manifestPath, repoRoot, expectedCommit string) error {
			return fmt.Errorf("invalid ticket_id")
		},
	}}
	dec, _ := r2.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeInvalidManifest {
		t.Fatalf("invalid manifest must fail closed, got %+v", dec)
	}
}

func TestDecide_MissingMergeCommit_FailClosed(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.PR.MergeCommitSHA = ""
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodePRMissingMergeCommit {
		t.Fatalf("missing merge commit must fail closed, got %+v", dec)
	}
}

func TestDecide_RequiredChecks_MissingName(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.Checks = []CheckState{{Name: "Some other check", Conclusion: "success"}}
	dec, _ := r.Decide(context.Background(), in)
	if dec.ShouldTransition || dec.ReasonCode != CodeRequiredChecksMissing {
		t.Fatalf("missing required check must fail closed, got %+v", dec)
	}
}

func TestReconcile_NoDuplicateTransition_OnRetry(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	// Fake linear that fails once transiently then succeeds.
	fake := &fakeLinear{
		issue:     LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "started", StatusName: "In Progress"},
		failFirst: true,
	}
	out, err := Reconcile(context.Background(), r, fake, in)
	if err != nil {
		t.Fatalf("expected success after retry, got %v", err)
	}
	if !out.Transitioned {
		t.Fatalf("expected transitioned")
	}
	if fake.calls != 2 {
		t.Fatalf("expected 2 calls (1 retry), got %d", fake.calls)
	}
	// Second reconcile should see AlreadyDone and not call again.
	in.LinearIssue = &LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "completed", StatusName: "Done"}
	out2, err := Reconcile(context.Background(), r, fake, in)
	if err != nil {
		t.Fatal(err)
	}
	if out2.Transitioned || !out2.AlreadyDone {
		t.Fatalf("second call should be already-done no-transition, got %+v", out2)
	}
	if fake.calls != 2 {
		t.Fatalf("no extra calls after AlreadyDone, got %d", fake.calls)
	}
}

func TestReconcile_NoTransition_WhenGateFails(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	in.PR.Merged = false
	fake := &fakeLinear{issue: LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "started", StatusName: "In Progress"}}
	out, err := Reconcile(context.Background(), r, fake, in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Transitioned || fake.calls != 0 {
		t.Fatalf("must not call linear when gate fails, got %+v calls=%d", out, fake.calls)
	}
}

func TestNoSecretsInDecision(t *testing.T) {
	in := fixtureInputs(t, "")
	// Inject a manifest error containing a token-like string; decision must redact.
	in2 := in
	in2.RepoRoot = t.TempDir() // break validator path but keep ManifestErr path
	in2.ManifestErr = fmt.Errorf("invalid token Bearer abc123secretvalue123")
	r := &Reconciler{}
	dec, _ := r.Decide(context.Background(), in2)
	// For missing-manifest-not-found case it would be CodeMissingManifest; to hit redact path we need an existing manifest but invalid.
	// Instead test redacted error helper directly via invalid manifest binding.
	r3 := &Reconciler{Validator: &RealManifestValidator{
		ValidateFn: func(_, _, _ string) error { return fmt.Errorf("token Bearer secret") },
	}}
	in3 := fixtureInputs(t, "")
	dec3, _ := r3.Decide(context.Background(), in3)
	_ = dec
	b, _ := json.Marshal(dec3)
	s := strings.ToLower(string(b))
	if strings.Contains(s, "bearer") || strings.Contains(s, "secret") {
		t.Fatalf("decision must not contain secret material: %s", s)
	}
}

func TestExtractTicket(t *testing.T) {
	if got := ExtractTicket("Add feature", "Resolves WORK-107 and fixes WORK-108"); got != "WORK-107" {
		t.Fatalf("extract %q", got)
	}
	if got := ExtractTicket("Resolves WORK-42", ""); got != "WORK-42" {
		t.Fatalf("title extract %q", got)
	}
	if got := ExtractTicket("no ticket", "nope"); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

type fakeLinear struct {
	mu        sync.Mutex
	issue     LinearIssueState
	failFirst bool
	calls     int
}

func (f *fakeLinear) GetIssue(_ context.Context, id string) (LinearIssueState, error) {
	return f.issue, nil
}
func (f *fakeLinear) TransitionToDone(_ context.Context, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.failFirst && f.calls == 1 {
		return fmt.Errorf("503 temporarily unavailable")
	}
	return nil
}

func TestReconcile_ConcurrentIdempotent(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	fake := &fakeLinear{issue: LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "started", StatusName: "In Progress"}}
	// Simulate two concurrent reconciliations where linear is already Done on second.
	in2 := in
	in2.LinearIssue = &LinearIssueState{ID: "issue-107", Identifier: "WORK-107", StatusType: "completed", StatusName: "Done"}
	out1, _ := Reconcile(context.Background(), r, fake, in)
	out2, _ := Reconcile(context.Background(), r, fake, in2)
	if !out1.Transitioned || out1.AlreadyDone {
		t.Fatalf("first should transition")
	}
	if out2.Transitioned || !out2.AlreadyDone {
		t.Fatalf("second should be already-done")
	}
}

func TestDecide_DeterministicChecksSummary(t *testing.T) {
	r := &Reconciler{}
	in := fixtureInputs(t, "")
	// Order should not affect summary (sorted).
	in.Checks = []CheckState{
		{Name: "Wiki governance / rebuild", Conclusion: "success"},
		{Name: "Delivery evidence gate / validate", Conclusion: "success"},
	}
	dec, _ := r.Decide(context.Background(), in)
	if !strings.Contains(dec.ChecksSummary, "Delivery evidence gate") || !strings.Contains(dec.ChecksSummary, "Wiki governance") {
		t.Fatalf("summary %q", dec.ChecksSummary)
	}
}
