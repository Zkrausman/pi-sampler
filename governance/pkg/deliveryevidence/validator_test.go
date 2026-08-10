package deliveryevidence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validManifest() Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion, TicketID: "WORK-104", OKFPath: "docs/specs/ticket.md", DeliveryState: "review_ready",
		PullRequest: PullRequest{Number: 1, URL: "https://github.com/project/project/pull/1", Draft: true}, CommitSHA: strings.Repeat("a", 40),
		Wiki:          WikiEvidence{SourceIDs: []string{"SRC-2026-08-06-001"}, PageIDs: []string{"requirements/delivery-evidence"}, ObservationIDs: []string{"obs-2026-08-06-delivery-evidence-contract"}},
		Verifications: []CommandResult{{Command: "go test ./...", ExitCode: 0, Outcome: "passed", OutputSHA256: strings.Repeat("b", 64)}},
		Review:        ReviewEvidence{Verdict: "self_review_complete", CommitSHA: strings.Repeat("a", 40)}, Merge: MergeEvidence{Status: "not_merged"},
	}
}
func testRoot(t *testing.T, withOKF bool) string {
	return testRootWithNewline(t, withOKF, "\n")
}

func testRootWithNewline(t *testing.T, withOKF bool, newline string) string {
	t.Helper()
	root := t.TempDir()
	if withOKF {
		path := filepath.Join(root, "docs", "specs")
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		contents := strings.Join([]string{"---", "type: implementation-ticket", "title: Ticket", "timestamp: 2026-08-06T00:00:00Z", "---", "# Ticket", ""}, newline)
		if err := os.WriteFile(filepath.Join(path, "ticket.md"), []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestValidateValidManifest(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n"} {
		t.Run(strings.ReplaceAll(newline, "\r", "CR"), func(t *testing.T) {
			if err := Validate(validManifest(), testRootWithNewline(t, true, newline)); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestValidateRejectsMissingOKF(t *testing.T) {
	err := Validate(validManifest(), testRoot(t, false))
	if err == nil || !strings.Contains(err.Error(), "read OKF") {
		t.Fatalf("got %v", err)
	}
}
func TestValidateRejectsMalformedAndDuplicateWikiIDs(t *testing.T) {
	m := validManifest()
	m.Wiki.SourceIDs = []string{"invalid"}
	if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(err.Error(), "malformed source") {
		t.Fatalf("got %v", err)
	}
	m = validManifest()
	m.Wiki.SourceIDs = []string{"SRC-2026-08-06-001", "SRC-2026-08-06-001"}
	if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(err.Error(), "duplicate source") {
		t.Fatalf("got %v", err)
	}
}
func TestValidateRejectsInvalidTransition(t *testing.T) {
	m := validManifest()
	m.DeliveryState = "published"
	if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(err.Error(), "published requires") {
		t.Fatalf("got %v", err)
	}
}
func TestValidateAcceptsClassifiedEnvironmentOnlyFailure(t *testing.T) {
	m := validManifest()
	m.Verifications = []CommandResult{{Command: "./project.exe test-suite", ExitCode: 0, Outcome: "environment_only", OutputSHA256: strings.Repeat("c", 64), FailureMarker: "[FAIL] broker OAuth unavailable", Classification: "environment_only", Reason: "requires live OAuth account"}}
	if err := Validate(m, testRoot(t, true)); err != nil {
		t.Fatal(err)
	}
}
func TestValidateRejectsIncompleteEnvironmentOnlyFailure(t *testing.T) {
	m := validManifest()
	m.Verifications = []CommandResult{{Command: "test", ExitCode: 0, Outcome: "environment_only", OutputSHA256: strings.Repeat("c", 64), FailureMarker: "[FAIL]"}}
	if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(err.Error(), "environment-only") {
		t.Fatalf("got %v", err)
	}
}
func TestValidateRejectsEscapingPathAndMissingFrontmatter(t *testing.T) {
	m := validManifest()
	m.OKFPath = "../secret.md"
	if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(err.Error(), "escapes repository root") {
		t.Fatalf("got %v", err)
	}
	root := testRoot(t, false)
	if err := os.MkdirAll(filepath.Join(root, "docs", "specs"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "specs", "ticket.md"), []byte("# no frontmatter"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := Validate(validManifest(), root); err == nil || !strings.Contains(err.Error(), "frontmatter") {
		t.Fatalf("got %v", err)
	}
}
func TestValidateFileRejectsNestedUnknownFields(t *testing.T) {
	root := testRoot(t, true)
	data, err := json.Marshal(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"draft":true`, `"draft":true,"unexpected":true`, 1))
	path := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFileAtCommit(path, root, strings.Repeat("a", 40)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateFileRejectsUnknownFields(t *testing.T) {
	root := testRoot(t, true)
	data, err := json.Marshal(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.TrimSuffix(string(data), "}") + `,"unexpected":true}`)
	path := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFileAtCommit(path, root, strings.Repeat("a", 40)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("got %v", err)
	}
}
func TestValidateFileAtCommitRejectsStaleCommit(t *testing.T) {
	root := testRoot(t, true)
	data, err := json.Marshal(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFileAtCommit(path, root, ""); err == nil || !strings.Contains(err.Error(), "expected delivery commit") {
		t.Fatalf("got %v", err)
	}
	if err := ValidateFileAtCommit(path, root, strings.Repeat("c", 40)); err == nil || !strings.Contains(err.Error(), "expected delivery commit") {
		t.Fatalf("got %v", err)
	}
	if err := ValidateFileAtCommit(path, root, strings.Repeat("a", 40)); err != nil {
		t.Fatal(err)
	}
}

func TestDigestOutput(t *testing.T) {
	if got := DigestOutput([]byte("evidence")); got != "ee8250fb76e094b34b471f13a73dbbe51d1ae142e9df59d7c0d31ec20f0a0a8e" {
		t.Fatal(got)
	}
}

func int64Ptr(v int64) *int64       { return &v }
func float64Ptr(v float64) *float64 { return &v }

func enrichedManifest() Manifest {
	m := validManifest()
	m.Harness = &Harness{
		Provider:         "openai-codex",
		Model:            "gpt-5",
		ThinkingLevel:    "high",
		ThinkingLevelMap: map[string]string{"openai-codex": "high"},
		Usage: &HarnessUsage{
			Input: int64Ptr(1200), Output: int64Ptr(800), Reasoning: int64Ptr(300),
			CacheRead: int64Ptr(400), CacheWrite: int64Ptr(100), TotalTokens: int64Ptr(2800),
		},
		Cost: &HarnessCost{
			Input: float64Ptr(0.01), Output: float64Ptr(0.02), CacheRead: float64Ptr(0.001), CacheWrite: float64Ptr(0.0005), Total: float64Ptr(0.0315),
		},
		ElapsedMs:   func() *int64 { v := int64(123456); return &v }(),
		HarnessType: "pi",
		DeveloperID: DeveloperIDForEmail("Dev@Example.COM "),
	}
	return m
}

func TestValidateAcceptsLegacyManifestWithoutHarness(t *testing.T) {
	if err := Validate(validManifest(), testRoot(t, true)); err != nil {
		t.Fatal(err)
	}
}

func TestValidateAcceptsEnrichedManifest(t *testing.T) {
	if err := Validate(enrichedManifest(), testRoot(t, true)); err != nil {
		t.Fatal(err)
	}
}

func TestValidateAcceptsEnrichedManifestRoundTripJSON(t *testing.T) {
	root := testRoot(t, true)
	m := enrichedManifest()
	data, _ := json.Marshal(m)
	path := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFileAtCommit(path, root, strings.Repeat("a", 40)); err != nil {
		t.Fatal(err)
	}
	// Legacy fixture without harness still round-trips.
	data2, _ := json.Marshal(validManifest())
	path2 := filepath.Join(root, "manifest2.json")
	if err := os.WriteFile(path2, data2, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFileAtCommit(path2, root, strings.Repeat("a", 40)); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRejectsInvalidDeveloperID(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   string
	}{
		{"raw email", "dev@example.com"},
		{"bare hex", strings.Repeat("a", 16)},
		{"upper hex", "sha256:" + strings.ToUpper(strings.Repeat("a", 16))},
		{"too short", "sha256:abc"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := enrichedManifest()
			m.Harness.DeveloperID = tc.id
			if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(err.Error(), "developer_id") {
				t.Fatalf("expected developer_id error, got %v", err)
			}
		})
	}
}

func TestDeveloperIDForEmailIsAnonymizedAndStable(t *testing.T) {
	a := DeveloperIDForEmail("Dev@Example.COM")
	b := DeveloperIDForEmail(" dev@example.com ")
	if a != b {
		t.Fatalf("expected normalized equality %q != %q", a, b)
	}
	if !developerID.MatchString(a) {
		t.Fatalf("bad shape %q", a)
	}
	if strings.Contains(a, "@") || strings.Contains(a, "dev") || strings.Contains(a, "Dev") {
		t.Fatalf("PII leaked in %q", a)
	}
	c := DeveloperIDForEmail("other@example.com")
	if a == c {
		t.Fatalf("collision between distinct emails")
	}
}

func TestValidateHarnessRejectsBadValues(t *testing.T) {
	neg := int64(-1)
	negF := float64(-0.01)
	bigMs := int64(8 * 24 * 60 * 60 * 1000)
	for _, tc := range []struct {
		name   string
		mutate func(*Manifest)
		want   string
	}{
		{"bad harnessType", func(m *Manifest) { m.Harness.HarnessType = "beads" }, "harnessType"},
		{"negative usage", func(m *Manifest) { m.Harness.Usage.Input = &neg }, "harness.usage"},
		{"negative cost", func(m *Manifest) { m.Harness.Cost.Total = &negF }, "harness.cost"},
		{"elapsed out of range", func(m *Manifest) { m.Harness.ElapsedMs = &bigMs }, "elapsedMs"},
		{"bad thinkingLevelMap", func(m *Manifest) { m.Harness.ThinkingLevelMap = map[string]string{"bad key!": "high"} }, "thinkingLevelMap"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := enrichedManifest()
			tc.mutate(&m)
			if err := Validate(m, testRoot(t, true)); err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.want)) {
				t.Fatalf("expected %q in %v", tc.want, err)
			}
		})
	}
}

func TestValidateRejectsUnknownHarnessSubfield(t *testing.T) {
	root := testRoot(t, true)
	m := enrichedManifest()
	data, _ := json.Marshal(m)
	// Inject unknown field under harness: should fail via DisallowUnknownFields on Decode.
	data = []byte(strings.Replace(string(data), `"provider":"openai-codex"`, `"provider":"openai-codex","unknownHarnessField":true`, 1))
	path := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateFileAtCommit(path, root, strings.Repeat("a", 40)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown field, got %v", err)
	}
}
