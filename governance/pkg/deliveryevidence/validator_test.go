package deliveryevidence

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
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

func copyPublishedSchemas(t *testing.T, root string) {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate delivery-evidence test source")
	}
	sourceDir := filepath.Join(filepath.Dir(sourceFile), "..", "..", "docs", "delivery-evidence")
	targetDir := filepath.Join(root, "governance", "docs", "delivery-evidence")
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"acceptance-manifest-v1.schema.json", "acceptance-matrix-v1.schema.json", "benchmark-evidence-v1.schema.json", "waiver-v1.schema.json"} {
		data, err := os.ReadFile(filepath.Join(sourceDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(targetDir, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func acceptanceFixture(t *testing.T) (root, manifestPath, matrixPath, base, head string) {
	t.Helper()
	root = t.TempDir()
	copyPublishedSchemas(t, root)
	planPath := filepath.Join(root, "docs", "techPlans")
	if err := os.MkdirAll(planPath, 0755); err != nil {
		t.Fatal(err)
	}
	plan := "# AIDEV-999 plan\\n\\n- [ ] A999-T01 ordinary\\n- [ ] A999-T02 benchmark\\n"
	planFile := filepath.Join(planPath, "AIDEV-999-implementation-plan.md")
	if err := os.WriteFile(planFile, []byte(plan), 0644); err != nil {
		t.Fatal(err)
	}
	base, head = strings.Repeat("a", 40), strings.Repeat("b", 40)
	manifest := AcceptanceManifest{
		SchemaVersion: AcceptanceManifestSchemaVersion,
		TicketID:      "AIDEV-999",
		Repository:    "Zkrausman/pi-sampler",
		PlanPath:      "docs/techPlans/AIDEV-999-implementation-plan.md",
		PlanSHA256:    fileSHA256([]byte(plan)),
		BaseSHA:       base,
		Rows: []AcceptancePlanRow{
			{ID: "A999-T01", Title: "ordinary", AcceptanceClass: "ordinary", Requirement: "ordinary evidence"},
			{ID: "A999-T02", Title: "benchmark", AcceptanceClass: "benchmark-ci-regression", Requirement: "benchmark evidence"},
		},
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath = filepath.Join(root, "manifest.json")
	if err := os.WriteFile(manifestPath, manifestData, 0644); err != nil {
		t.Fatal(err)
	}
	benchmarkPath := filepath.Join(root, "benchmark.json")
	benchmark := validBenchmarkEvidence("AIDEV-999", "Zkrausman/pi-sampler", base, head, "ci-regression")
	benchmarkData, err := json.Marshal(benchmark)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(benchmarkPath, benchmarkData, 0644); err != nil {
		t.Fatal(err)
	}
	matrix := AcceptanceMatrix{
		SchemaVersion:     AcceptanceMatrixSchemaVersion,
		TicketID:          manifest.TicketID,
		Repository:        manifest.Repository,
		PlanSHA256:        manifest.PlanSHA256,
		ManifestSHA256:    fileSHA256(manifestData),
		BaseSHA:           base,
		HeadSHA:           head,
		PullRequestNumber: 42,
		GeneratedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		Rows: []AcceptanceMatrixRow{
			{ID: "A999-T01", Status: "observed", Observed: &ObservedEvidence{AcceptanceClass: "ordinary", Verifier: "go-test", Command: "go test", ToolVersion: "go1.25", EnvironmentClass: "local", ExitStatus: 0, StartedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), CompletedAt: time.Now().UTC().Format(time.RFC3339Nano), Artifacts: []ArtifactDigest{{Name: "stdout", SHA256: strings.Repeat("c", 64), Bytes: 1}}}},
			{ID: "A999-T02", Status: "observed", Observed: &ObservedEvidence{AcceptanceClass: "benchmark-ci-regression", Verifier: "benchmark", Command: "node benchmark", ToolVersion: "node24", EnvironmentClass: "local", ExitStatus: 0, StartedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), CompletedAt: time.Now().UTC().Format(time.RFC3339Nano), Artifacts: []ArtifactDigest{{Name: "benchmark", SHA256: strings.Repeat("d", 64), Bytes: int64(len(benchmarkData))}}, BenchmarkEvidence: &BenchmarkEvidenceRef{Path: "benchmark.json", SHA256: fileSHA256(benchmarkData)}}},
		},
	}
	matrixData, err := json.Marshal(matrix)
	if err != nil {
		t.Fatal(err)
	}
	matrixPath = filepath.Join(root, "matrix.json")
	if err := os.WriteFile(matrixPath, matrixData, 0644); err != nil {
		t.Fatal(err)
	}
	return root, manifestPath, matrixPath, base, head
}

func validBenchmarkEvidence(ticket, repository, base, head, benchmarkClass string) BenchmarkEvidence {
	now := time.Now().UTC()
	samples := []RSSSample{{Events: 0, RSSBytes: 100}, {Events: CIRegressionEvents, RSSBytes: 200}}
	run := BenchmarkRun{Repetition: 1, EventCount: CIRegressionEvents, CompletedEvents: CIRegressionEvents, DurationMS: 10, PeakRSSBytes: 200, RSSSamples: samples, SlopeBytesPerEvent: 0.01, Variance: 2500}
	return BenchmarkEvidence{
		SchemaVersion: BenchmarkEvidenceSchemaVersion, TicketID: ticket, Repository: repository, BaseSHA: base, HeadSHA: head, Class: benchmarkClass,
		WorkloadDigest: strings.Repeat("e", 64), EventCount: CIRegressionEvents, WarmupEvents: 1, Repetitions: 1, TimeoutMS: 1000,
		StartedAt: now.Add(-time.Second).Format(time.RFC3339Nano), CompletedAt: now.Format(time.RFC3339Nano), EventComplete: true,
		SlopeEstimator: "theil-sen", Runs: []BenchmarkRun{run}, Summary: BenchmarkSummary{DurationMS: 10, PeakRSSBytes: 200, SlopeBytesPerEvent: 0.01, Variance: 0, CompletedEvents: CIRegressionEvents},
		Environment: BenchmarkEnvironment{Runtime: "node 24", HardwareClass: "test", CPUCount: 1, MemoryBytes: 1024}, Outcome: "baseline",
	}
}

func TestAcceptanceManifestAndMatrixBindEveryStableRow(t *testing.T) {
	root, manifestPath, matrixPath, base, head := acceptanceFixture(t)
	if err := ValidateAcceptanceBundle(manifestPath, matrixPath, root, "Zkrausman/pi-sampler", base, head, 42, "", ""); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest AcceptanceManifest
	if err := decodeStrictJSON(data, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Rows[1].ID = "A999-T03"
	changed, _ := json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, changed, 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAcceptanceManifestFile(manifestPath, root, "Zkrausman/pi-sampler", base); err == nil {
		t.Fatal("unknown/deleted acceptance row was accepted")
	}
}

func TestAcceptanceManifestPlanDigestIsNewlineInvariant(t *testing.T) {
	rootLF, manifestLF, _, base, _ := acceptanceFixture(t)
	if err := ValidateAcceptanceManifestFile(manifestLF, rootLF, "Zkrausman/pi-sampler", base); err != nil {
		t.Fatalf("LF plan should validate: %v", err)
	}

	rootCRLF, manifestCRLF, _, crlfBase, _ := acceptanceFixture(t)
	planPath := filepath.Join(rootCRLF, "docs", "techPlans", "AIDEV-999-implementation-plan.md")
	planBytes, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	crlfPlan := strings.ReplaceAll(string(planBytes), "\n", "\r\n")
	if err := os.WriteFile(planPath, []byte(crlfPlan), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAcceptanceManifestFile(manifestCRLF, rootCRLF, "Zkrausman/pi-sampler", crlfBase); err != nil {
		t.Fatalf("CRLF plan should validate with the same digest: %v", err)
	}

	mutatedRoot, mutatedManifest, _, mutatedBase, _ := acceptanceFixture(t)
	mutatedPlanPath := filepath.Join(mutatedRoot, "docs", "techPlans", "AIDEV-999-implementation-plan.md")
	mutatedPlanBytes, err := os.ReadFile(mutatedPlanPath)
	if err != nil {
		t.Fatal(err)
	}
	mutatedPlan := strings.Replace(string(mutatedPlanBytes), "A999-T01 ordinary", "A999-T01 changed", 1)
	if mutatedPlan == string(mutatedPlanBytes) || strings.Count(mutatedPlan, "\n") != strings.Count(string(mutatedPlanBytes), "\n") {
		t.Fatal("ordinary plan mutation did not preserve LF line endings")
	}
	if err := os.WriteFile(mutatedPlanPath, []byte(mutatedPlan), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAcceptanceManifestFile(mutatedManifest, mutatedRoot, "Zkrausman/pi-sampler", mutatedBase); err == nil || !strings.Contains(err.Error(), "plan_sha256") {
		t.Fatalf("ordinary plan-content mutation was accepted: %v", err)
	}
}

func TestPublishedSchemasRejectInvalidManifestMatrixBenchmarkAndWaiver(t *testing.T) {
	t.Run("manifest", func(t *testing.T) {
		root, manifestPath, _, base, _ := acceptanceFixture(t)
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		raw["plan_path"] = ".review-artifacts/plan.txt"
		changed, _ := json.Marshal(raw)
		if err := os.WriteFile(manifestPath, changed, 0644); err != nil {
			t.Fatal(err)
		}
		if err := ValidateAcceptanceManifestFile(manifestPath, root, "Zkrausman/pi-sampler", base); err == nil || !strings.Contains(err.Error(), "published schema") {
			t.Fatalf("schema-invalid manifest was accepted: %v", err)
		}
	})
	t.Run("matrix", func(t *testing.T) {
		root, manifestPath, matrixPath, base, head := acceptanceFixture(t)
		data, err := os.ReadFile(matrixPath)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatal(err)
		}
		rows := raw["rows"].([]any)
		rows[0].(map[string]any)["status"] = "unknown"
		changed, _ := json.Marshal(raw)
		if err := os.WriteFile(matrixPath, changed, 0644); err != nil {
			t.Fatal(err)
		}
		if err := ValidateAcceptanceBundle(manifestPath, matrixPath, root, "Zkrausman/pi-sampler", base, head, 42, "", ""); err == nil || !strings.Contains(err.Error(), "published schema") {
			t.Fatalf("schema-invalid matrix was accepted: %v", err)
		}
	})
	t.Run("benchmark", func(t *testing.T) {
		root := t.TempDir()
		copyPublishedSchemas(t, root)
		base, head := strings.Repeat("a", 40), strings.Repeat("b", 40)
		path := filepath.Join(root, "benchmark.json")
		evidence := validBenchmarkEvidence("AIDEV-999", "Zkrausman/pi-sampler", base, head, "ci-regression")
		raw, _ := json.Marshal(evidence)
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		delete(value, "summary")
		changed, _ := json.Marshal(value)
		if err := os.WriteFile(path, changed, 0644); err != nil {
			t.Fatal(err)
		}
		if err := ValidateBenchmarkEvidenceFileAt(path, root, "Zkrausman/pi-sampler", base, head, "ci-regression"); err == nil || !strings.Contains(err.Error(), "published schema") {
			t.Fatalf("schema-invalid benchmark was accepted: %v", err)
		}
	})
	t.Run("waiver", func(t *testing.T) {
		root := t.TempDir()
		copyPublishedSchemas(t, root)
		operatorRoot := t.TempDir()
		path := filepath.Join(operatorRoot, "waiver.json")
		if err := os.WriteFile(path, []byte(`{"schema_version":"delivery-waiver/v1","extra":true}`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := ValidateWaiverFile(path, "unused", "unused", root, "Zkrausman/pi-sampler", "AIDEV-999", "A999-T01", strings.Repeat("c", 64), strings.Repeat("a", 40), strings.Repeat("b", 40), 42); err == nil || !strings.Contains(err.Error(), "published schema") {
			t.Fatalf("schema-invalid waiver was accepted: %v", err)
		}
	})
}

func TestBenchmarkBaselineCannotClaimPassAndLocalClassRequiresTenMillion(t *testing.T) {
	evidence := validBenchmarkEvidence("AIDEV-999", "Zkrausman/pi-sampler", strings.Repeat("a", 40), strings.Repeat("b", 40), "ci-regression")
	if err := ValidateBenchmarkEvidenceAt(evidence, evidence.Repository, evidence.BaseSHA, evidence.HeadSHA, "ci-regression", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	evidence.Outcome = "passed"
	evidence.Thresholds = &BenchmarkThresholds{MaxDurationMS: 1_800_000, MaxPeakRSSBytes: maxBenchmarkRSSBytes, MaxSlopeBytesPerEvent: maxBenchmarkRSSBytes, MaxVariance: maxBenchmarkRSSBytes}
	if err := ValidateBenchmarkEvidenceAt(evidence, evidence.Repository, evidence.BaseSHA, evidence.HeadSHA, "ci-regression", time.Now().UTC()); err == nil {
		t.Fatal("self-authored threshold/pass artifact was accepted")
	}
	evidence.Outcome = "baseline"
	if err := ValidateBenchmarkEvidenceAt(evidence, evidence.Repository, evidence.BaseSHA, evidence.HeadSHA, "ci-regression", time.Now().UTC()); err == nil {
		t.Fatal("candidate-authored thresholds were accepted on a baseline")
	}
	evidence.Thresholds = nil
	evidence.Class = "local-10m"
	if err := ValidateBenchmarkEvidenceAt(evidence, evidence.Repository, evidence.BaseSHA, evidence.HeadSHA, "local-10m", time.Now().UTC()); err == nil {
		t.Fatal("smaller CI evidence satisfied the local 10M class")
	}
}

func v2Now() string {
	return time.Now().UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
func v2Facts(matrix AcceptanceMatrixV2) NormalizedFactsV1 {
	rows := make([]NormalizedFactsV1Row, len(matrix.Rows))
	for index, row := range matrix.Rows {
		rows[index] = NormalizedFactsV1Row{ID: row.ID, AcceptanceClass: row.AcceptanceClass, Requirement: row.Requirement}
	}
	return NormalizedFactsV1{Format: NormalizedFactsV1Format, Version: NormalizedFactsV1Version, Repository: matrix.Repository, TicketID: matrix.TicketID, TicketRevision: matrix.TicketRevision, ProfilePath: matrix.ProfilePath, ProfileSHA256: matrix.ProfileSHA256, BaseSHA: matrix.BaseSHA, HeadSHA: matrix.HeadSHA, PullRequestNumber: matrix.PullRequestNumber, PlanPath: matrix.PlanPath, PlanSHA256: matrix.PlanSHA256, ManifestPath: matrix.ManifestPath, ManifestSHA256: matrix.ManifestSHA256, ManifestSchemaVersion: matrix.ManifestSchemaVersion, ManifestContractSHA256: matrix.ManifestContractSHA256, ManifestValidatorSHA256: matrix.ManifestValidatorSHA256, MatrixContractSHA256: matrix.MatrixContractSHA256, PolicySHA256: matrix.PolicySHA256, EvaluationScope: matrix.EvaluationScope, Rows: rows}
}
func v2Matrix(scope, class string, evidence *AcceptanceEvidenceV2, blocker *AcceptanceBlockerV2) AcceptanceMatrixV2 {
	base := strings.Repeat("a", 40)
	head := strings.Repeat("b", 40)
	digest := strings.Repeat("c", 64)
	row := AcceptanceMatrixV2Row{ID: "AIDEV-191-1", AcceptanceClass: class, Requirement: "A bounded v2 requirement.", Status: "observed", Evidence: evidence}
	if scope == "plan-publication" {
		row.Status = "specified"
		row.Specification = evidence
		row.Evidence = nil
	}
	if blocker != nil {
		row.Status = "blocked"
		row.Evidence = nil
		row.Blocker = blocker
	}
	return AcceptanceMatrixV2{SchemaVersion: AcceptanceMatrixV2SchemaVersion, ManifestSchemaVersion: AcceptanceManifestV2SchemaVersion, EvaluationScope: scope, Repository: "Zkrausman/pi-sampler", TicketID: "AIDEV-191", TicketRevision: strings.Repeat("d", 64), ProfilePath: "profiles/pi-sampler.json", ProfileSHA256: digest, BaseSHA: base, HeadSHA: head, PullRequestNumber: 191, PlanPath: "docs/techPlans/AIDEV-191-implementation-plan.md", PlanSHA256: digest, ManifestPath: "docs/techPlans/AIDEV-191-acceptance-manifest-v2.json", ManifestSHA256: digest, ManifestContractPath: "contracts/implementation-plan-manifest-v2.mjs", ManifestContractSHA256: digest, ManifestValidatorPath: "scripts/validate-implementation-plan.mjs", ManifestValidatorSHA256: digest, MatrixContractPath: "governance/docs/delivery-evidence/acceptance-matrix-v2.schema.json", MatrixContractSHA256: digest, PolicyPath: "profiles/pi-sampler.json", PolicySHA256: digest, EvidenceRootID: "operator-root-191", GeneratedAt: v2Now(), Rows: []AcceptanceMatrixV2Row{row}}
}
func v2Evidence(rootFile string, data []byte, inventory []byte) AcceptanceEvidenceV2 {
	return AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "test-verifier", Version: "v1", Environment: "local", Argv: []string{"test"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: []AcceptanceArtifactV2{{Name: "proof.txt", Path: rootFile, SHA256: fileSHA256(data), Bytes: int64(len(data))}, {Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))}}}
}
func writeV2Inventory(t *testing.T, root string) []byte {
	t.Helper()
	opened, err := OpenExternalEvidenceRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	computed, err := InventoryExternalEvidenceRoot(opened)
	if err != nil {
		t.Fatal(err)
	}
	inventory := CanonicalExternalEvidenceInventoryReport(computed)
	if err := os.WriteFile(filepath.Join(root, "evidence-inventory.json"), inventory, 0600); err != nil {
		t.Fatal(err)
	}
	return inventory
}
func v2Request(matrix AcceptanceMatrixV2, root string, policy AcceptancePolicyV2) AcceptanceV2Request {
	facts := v2Facts(matrix)
	matrixBytes := canonicalAcceptanceMatrixV2Bytes(matrix)
	policyBytes, _ := json.Marshal(policy)
	return AcceptanceV2Request{Format: AcceptanceV2RequestFormat, Version: AcceptanceV2RequestVersion, NormalizedFacts: facts, FactsSHA256: normalizedFactsDigestV1(facts), MatrixBase64: base64.StdEncoding.EncodeToString(matrixBytes), EvidenceRoot: root, Policy: policyBytes, ControllerTime: matrix.GeneratedAt}
}
func TestAcceptanceV2(t *testing.T) {
	t.Run("A191-T01", func(t *testing.T) {
		data, err := os.ReadFile("../../docs/delivery-evidence/acceptance-matrix-v2.schema.json")
		if err != nil {
			t.Fatal(err)
		}
		var schema any
		if err := json.Unmarshal(data, &schema); err != nil {
			t.Fatal(err)
		}
		var visit func(any)
		visit = func(value any) {
			if object, ok := value.(map[string]any); ok {
				if object["type"] == "object" && object["additionalProperties"] != false {
					t.Fatalf("object without strict properties")
				}
				for _, child := range object {
					visit(child)
				}
			} else if array, ok := value.([]any); ok {
				for _, child := range array {
					visit(child)
				}
			}
		}
		visit(schema)
		root := t.TempDir()
		proofData := []byte("proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), proofData, 0600); err != nil {
			t.Fatal(err)
		}
		inventory := writeV2Inventory(t, root)
		evidence := v2Evidence("proof.txt", proofData, inventory)
		matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
		policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
		result := ValidateAcceptanceV2(v2Request(matrix, root, policy))
		if result.Status != "valid" || result.Code != "observed" {
			t.Fatalf("runtime v2 guard did not run: %+v", result)
		}
		matrix.Rows[0].Requirement = strings.Repeat("é", 1024)
		if parity := ValidateAcceptanceV2(v2Request(matrix, root, policy)); parity.Status != "valid" || parity.Code != "observed" {
			t.Fatalf("valid UTF-8 at the byte limit was rejected: %+v", parity)
		}
		matrix.Rows[0].Requirement = strings.Repeat("é", 1025)
		if parity := ValidateAcceptanceV2(v2Request(matrix, root, policy)); parity.Code != "matrix_schema_invalid" {
			t.Fatalf("UTF-8 byte-limit divergence: %+v", parity)
		}
	})
	t.Run("A191-T02", func(t *testing.T) {
		v1MatrixBytes := []byte(`{"schema_version":"acceptance-matrix/v1","rows":[]}`)
		v1ManifestBytes := []byte(`{"schema_version":"acceptance-manifest/v1","rows":[]}`)
		v2MatrixBytes := []byte(`{"schema_version":"acceptance-matrix/v2","manifest_schema_version":"implementation-plan-manifest/v2","rows":[]}`)
		v2ManifestBytes := []byte(`{"schema_version":"implementation-plan-manifest/v2","rows":[]}`)
		if pair := ClassifyAcceptanceVersionPair(v1MatrixBytes, v1ManifestBytes); pair != "v1/v1" {
			t.Fatalf("exact v1 pair did not select the frozen boundary: %s", pair)
		}
		if pair := ClassifyAcceptanceVersionPair(v2MatrixBytes, v2ManifestBytes); pair != "v2/v2" {
			t.Fatalf("exact v2 pair did not select the additive boundary: %s", pair)
		}
		if pair := ClassifyAcceptanceVersionPair(v1MatrixBytes, v2ManifestBytes); pair != "version_pair_mixed" {
			t.Fatalf("v1 matrix/v2 manifest was not mixed: %s", pair)
		}
		if pair := ClassifyAcceptanceVersionPair(v2MatrixBytes, v1ManifestBytes); pair != "version_pair_mixed" {
			t.Fatalf("v2 matrix/v1 manifest was not mixed: %s", pair)
		}
		root := t.TempDir()
		data := []byte("proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		matrix := v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: "dispatch mutation", BlockedBy: nil})
		matrix.ManifestSchemaVersion = AcceptanceManifestSchemaVersion
		result := ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{}))
		if result.Code != "version_pair_mixed" {
			t.Fatalf("unexpected dispatch result: %+v", result)
		}
		var raw map[string]any
		if err := json.Unmarshal(canonicalAcceptanceMatrixV2Bytes(v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: "dispatch mutation", BlockedBy: nil})), &raw); err != nil {
			t.Fatal(err)
		}
		raw["schema_version"] = "acceptance-matrix/v9"
		unsupportedBytes, _ := json.Marshal(raw)
		unsupportedRequest := v2Request(v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: "dispatch mutation", BlockedBy: nil}), root, AcceptancePolicyV2{})
		unsupportedRequest.MatrixBase64 = base64.StdEncoding.EncodeToString(unsupportedBytes)
		unsupportedRequest.NormalizedFacts.ManifestSchemaVersion = AcceptanceManifestV2SchemaVersion
		unsupportedRequest.FactsSHA256 = normalizedFactsDigestV1(unsupportedRequest.NormalizedFacts)
		if unsupported := ValidateAcceptanceV2(unsupportedRequest); unsupported.Code != "version_pair_unsupported" {
			t.Fatalf("unsupported pair was admitted: %+v", unsupported)
		}
		legacyRequest := v2Request(v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: "legacy dispatch", BlockedBy: nil}), root, AcceptancePolicyV2{})
		legacyRequest.MatrixBase64 = base64.StdEncoding.EncodeToString(v1MatrixBytes)
		legacyRequest.NormalizedFacts.ManifestSchemaVersion = AcceptanceManifestSchemaVersion
		legacyRequest.FactsSHA256 = normalizedFactsDigestV1(legacyRequest.NormalizedFacts)
		if legacy := ValidateAcceptanceV2(legacyRequest); legacy.Code != "version_pair_unsupported" {
			t.Fatalf("v1 pair was projected into v2: %+v", legacy)
		}
	})
	t.Run("A191-T03", func(t *testing.T) {
		plan, err := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md")
		if err != nil {
			t.Fatal(err)
		}
		manifest, err := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json")
		if err != nil {
			t.Fatal(err)
		}
		result := ParseImplementationPlanManifestV2Compatibility(plan, manifest)
		if result.Status != "valid" || result.Code != "compatibility_tuple_understood" || result.DeliveryAdmitted || len(result.Rows) != 12 {
			t.Fatalf("unexpected compatibility result: %+v", result)
		}
		mutated := bytes.Replace(append([]byte(nil), manifest...), []byte("AIDEV-187-1"), []byte("AIDEV-187-2"), 1)
		if changed := ParseImplementationPlanManifestV2Compatibility(plan, mutated); changed.Status == "valid" || changed.DeliveryAdmitted {
			t.Fatalf("mutated compatibility tuple admitted: %+v", changed)
		}
	})
	t.Run("A191-T04", func(t *testing.T) {
		// Slice 1B substantively verifies the v2 production binding rejection. Trusted
		// controller/blob selection and activation ordering are later Slice 2 authority.
		root := t.TempDir()
		data := []byte("proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		inventory := writeV2Inventory(t, root)
		evidence := v2Evidence("proof.txt", data, inventory)
		matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
		request := v2Request(matrix, root, AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}})
		matrix.Repository = "Other/repository"
		request.MatrixBase64 = base64.StdEncoding.EncodeToString(canonicalAcceptanceMatrixV2Bytes(matrix))
		result := ValidateAcceptanceV2(request)
		if result.Status != "invalid" || result.Code != "binding_mismatch" || len(result.Rows) != 1 || result.Rows[0].Status != "invalid" || result.Rows[0].Code != "binding_mismatch" {
			t.Fatalf("unexpected production binding result: %+v", result)
		}
		if !hasV2Diagnostic(result, "binding_mismatch") {
			t.Fatalf("binding diagnostic was lost: %+v", result.Diagnostics)
		}
	})
	t.Run("A191-T05", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		inventory := writeV2Inventory(t, root)
		evidence := v2Evidence("proof.txt", data, inventory)
		matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
		policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
		result := ValidateAcceptanceV2(v2Request(matrix, root, policy))
		if result.Status != "valid" || result.Code != "observed" {
			t.Fatalf("unexpected result: %+v", result)
		}
		runA191T05ExactBounds(t)
	})
	t.Run("A191-T06", func(t *testing.T) {
		root := t.TempDir()
		validator, review := []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved\n")
		if err := os.WriteFile(filepath.Join(root, "plan-validator-report.json"), validator, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), review, 0600); err != nil {
			t.Fatal(err)
		}
		inventory := writeV2Inventory(t, root)
		evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: []AcceptanceArtifactV2{{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))}, {Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))}, {Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))}}}
		matrix := v2Matrix("plan-publication", "authority", &evidence, nil)
		result := ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{}))
		if result.Status != "valid" || result.Code != "specified" {
			t.Fatalf("unexpected result: %+v", result)
		}
	})
	t.Run("A191-T07", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		inventory := writeV2Inventory(t, root)
		evidence := v2Evidence("proof.txt", data, inventory)
		evidence.Artifacts[0].SHA256 = strings.Repeat("0", 64)
		matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
		policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
		result := ValidateAcceptanceV2(v2Request(matrix, root, policy))
		if result.Code != "artifact_digest_mismatch" {
			t.Fatalf("unexpected result: %+v", result)
		}
		rootObject, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		correct := AcceptanceArtifactV2{Name: "proof.txt", Path: "proof.txt", SHA256: fileSHA256(data), Bytes: int64(len(data))}
		if _, err := ReadVerifiedArtifact(rootObject, correct); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(filepath.Join(root, "proof.txt"), filepath.Join(root, "hardlink.txt")); err == nil {
			linked := correct
			linked.Path = "hardlink.txt"
			if _, err := ReadVerifiedArtifact(rootObject, linked); err == nil {
				t.Fatal("hard link was accepted")
			}
		}
		if err := os.Symlink(filepath.Join(root, "proof.txt"), filepath.Join(root, "symlink.txt")); err == nil {
			linked := correct
			linked.Path = "symlink.txt"
			if _, err := ReadVerifiedArtifact(rootObject, linked); err == nil {
				t.Fatal("symlink was accepted")
			}
		}
	})
	t.Run("A191-T08", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		inventory := writeV2Inventory(t, root)
		evidence := v2Evidence("proof.txt", data, inventory)
		matrix := v2Matrix("implementation-delivery", "benchmark", &evidence, nil)
		policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "benchmark-ci-regression", Kind: "benchmark", Verifier: "benchmark", Environment: "ci", Command: []string{"benchmark"}}, {ID: "benchmark-local-10m", Kind: "benchmark", Verifier: "benchmark", Environment: "local", Command: []string{"benchmark"}}}}
		result := ValidateAcceptanceV2(v2Request(matrix, root, policy))
		if result.Status != "blocked" || result.Code != "unsupported_class_policy" {
			t.Fatalf("unexpected result: %+v", result)
		}
	})
	t.Run("A191-T09", func(t *testing.T) {
		// Slice 1B proves the production publication boundary while leaving trusted
		// controller/ordering/receipt authority explicitly to later Slice 2.
		if _, err := os.Stat("../../../contracts/delivery-acceptance-v2-activation.json"); !os.IsNotExist(err) {
			t.Fatalf("activation declaration unexpectedly present: %v", err)
		}
		if _, err := os.Stat("../../../contracts/delivery-acceptance-v2-trusted-map.json"); !os.IsNotExist(err) {
			t.Fatalf("trusted map unexpectedly present: %v", err)
		}
		request, root := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
		result := ValidateAcceptanceV2(request)
		if result.Status != "valid" || result.Code != "specified" || len(result.Rows) != 2 {
			t.Fatalf("public publication boundary was not exercised: %+v", result)
		}
		assertV2Rows(t, result, []string{"valid", "valid"}, []string{"specified", "specified"})
		if _, err := os.Stat(root); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("A191-T10", func(t *testing.T) {
		plan, _ := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md")
		manifest, _ := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json")
		result := ParseImplementationPlanManifestV2Compatibility(plan, manifest)
		if len(result.Rows) != 12 || result.Rows[0].ID != "AIDEV-187-1" || result.DeliveryAdmitted {
			t.Fatalf("unexpected tuple: %+v", result)
		}
		// The old-v1 boundary is verified through the real CLI so exit status and
		// published-schema stderr, not only an in-process parser result, are bound.
		legacyCases := []struct {
			name   string
			mutate func(map[string]any)
			want   []string
		}{
			{"schema mismatch", func(raw map[string]any) { raw["schema_version"] = "implementation-plan-manifest/v2" }, []string{"does not match published schema acceptance-manifest-v1.schema.json", "/schema_version"}},
			{"row ID pattern", func(raw map[string]any) {
				rows, ok := raw["rows"].([]any)
				if !ok || len(rows) == 0 {
					t.Fatalf("legacy fixture rows unavailable: %#v", raw["rows"])
				}
				row, ok := rows[0].(map[string]any)
				if !ok {
					t.Fatalf("legacy fixture row has unexpected type: %#v", rows[0])
				}
				row["id"] = "A999-T1"
			}, []string{"does not match published schema acceptance-manifest-v1.schema.json", "/rows/0/id", "^A[0-9]{1,9}-T[0-9]{2,4}$"}},
		}
		for _, tc := range legacyCases {
			t.Run(tc.name, func(t *testing.T) {
				root, manifestPath, _, base, _ := acceptanceFixture(t)
				data, err := os.ReadFile(manifestPath)
				if err != nil {
					t.Fatal(err)
				}
				var raw map[string]any
				if err := json.Unmarshal(data, &raw); err != nil {
					t.Fatal(err)
				}
				tc.mutate(raw)
				changed, err := json.Marshal(raw)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(manifestPath, changed, 0600); err != nil {
					t.Fatal(err)
				}
				exitCode, stdout, stderr := runLegacyManifestCLI(t, root, manifestPath, base)
				if exitCode != 1 || stdout != "" {
					t.Fatalf("legacy CLI exit/stdout mismatch: exit=%d stdout=%q stderr=%q", exitCode, stdout, stderr)
				}
				for _, substring := range tc.want {
					if !strings.Contains(stderr, substring) {
						t.Fatalf("legacy CLI stderr missing %q: %q", substring, stderr)
					}
				}
			})
		}
	})
	t.Run("A191-T11", func(t *testing.T) {
		matrix := v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: "not activated", BlockedBy: nil})
		one := canonicalAcceptanceMatrixV2Bytes(matrix)
		two := canonicalAcceptanceMatrixV2Bytes(matrix)
		if !bytes.Equal(one, two) || !bytes.HasSuffix(one, []byte("\n")) {
			t.Fatal("matrix canonical bytes are not deterministic")
		}
		root := t.TempDir()
		data := []byte("platform proof")
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		artifact := AcceptanceArtifactV2{Name: "proof.txt", Path: "proof.txt", SHA256: fileSHA256(data), Bytes: int64(len(data))}
		if _, err := ReadVerifiedArtifact(opened, artifact); err != nil {
			t.Fatalf("platform artifact route failed: %v", err)
		}
		inventory, err := InventoryExternalEvidenceRoot(opened)
		if err != nil || len(inventory.Entries) != 1 || inventory.Entries[0].Path != "proof.txt" {
			t.Fatalf("platform inventory route failed: %v %+v", err, inventory)
		}
		// This is the applicable deterministic/platform boundary; protected CI,
		// lifecycle, DCO, and merge authority remain later gates.
		runPlatformExternalEvidenceAdversaries(t)
	})
	t.Run("A191-T12", func(t *testing.T) {
		// Slice 1B owns frozen-byte and packet-boundary evidence only. The full
		// receipt/marker/protected-CI/DCO/merge lifecycle is later/inapplicable here.
		files := []struct {
			path, sha256 string
		}{
			{"../../docs/delivery-evidence/acceptance-manifest-v1.schema.json", "03733cedbc78f42ffc9268d7da7071184b2bf2ab702a0d4211237b278526d53d"},
			{"../../docs/delivery-evidence/acceptance-matrix-v1.schema.json", "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021"},
			{"acceptance.go", "1ada2e07253b0b1c5053461cb9d2e4689b14948358b779b847842d50033fcfb6"},
			{"schema.go", "99a2acfc90622040995864b48f1194b919f2a679f7460df57d8a5aa8eddf83fd"},
		}
		for _, file := range files {
			data, err := os.ReadFile(file.path)
			if err != nil {
				t.Fatal(err)
			}
			if fileSHA256(data) != file.sha256 {
				t.Fatalf("frozen v1/lifecycle boundary changed: %s", file.path)
			}
		}
		if _, err := os.Stat("../../../contracts/delivery-acceptance-v2-activation.json"); !os.IsNotExist(err) {
			t.Fatalf("activation declaration unexpectedly present: %v", err)
		}
		if _, err := os.Stat("../../../contracts/delivery-acceptance-v2-trusted-map.json"); !os.IsNotExist(err) {
			t.Fatalf("trusted map unexpectedly present: %v", err)
		}
	})
}
func publicationV2Request(t *testing.T, validator, review []byte) AcceptanceV2Request {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "plan-validator-report.json"), validator, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), review, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: []AcceptanceArtifactV2{{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))},
		{Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))}, {Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))}}}
	return v2Request(v2Matrix("plan-publication", "authority", &evidence, nil), root, AcceptancePolicyV2{})
}
func TestAcceptanceV2PublicationEvidenceIsAnchoredAndStrict(t *testing.T) {
	cases := []struct {
		name      string
		validator []byte
		review    []byte
	}{{"validator exit alias", []byte(`{"ok":true,"exit":0}`), []byte("decision: approved")}, {"validator extra", []byte(`{"ok":true,"exit_status":0,"extra":1}`), []byte("decision: approved")},
		{"validator duplicate", []byte(`{"ok":true,"exit_status":0,"exit_status":0}`), []byte("decision: approved")}, {"unapproved", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: unapproved")}, {"disapproved", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: disapproved")}, {"historical", []byte(`{"ok":true,"exit_status":0}`), []byte("historical decision: approved")},
		{"duplicate decision", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved\ndecision: approved")}, {"conditional", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved\nconditional approval is pending")}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := ValidateAcceptanceV2(publicationV2Request(t, tc.validator, tc.review))
			if result.Status != "invalid" || result.Code != "matrix_schema_invalid" {
				t.Fatalf("unexpected publication result: %+v", result)
			}
		})
	}
	positive := ValidateAcceptanceV2(publicationV2Request(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved")))
	if positive.Status != "valid" || positive.Code != "specified" {
		t.Fatalf("strict positive rejected: %+v", positive)
	}
}
func TestAcceptanceV2ClosedWorldInventoryRejectsExtrasAndNesting(t *testing.T) {
	root := t.TempDir()
	data := []byte("proof")
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := v2Evidence("proof.txt", data, inventory)
	matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	if err := os.WriteFile(filepath.Join(root, "unreferenced-secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	inventory = writeV2Inventory(t, root)
	evidence.Artifacts[1] = AcceptanceArtifactV2{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))}
	matrix.Rows[0].Evidence = &evidence
	result := ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}))
	if result.Code != "artifact_path_mismatch" {
		t.Fatalf("extra file was accepted: %+v", result)
	}
	root = t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	inventory = writeV2Inventory(t, root)
	evidence = v2Evidence("proof.txt", data, inventory)
	matrix = v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	if err := os.Mkdir(filepath.Join(root, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "extra.txt"), []byte("extra"), 0600); err != nil {
		t.Fatal(err)
	}
	inventory = writeV2Inventory(t, root)
	evidence.Artifacts[1] = AcceptanceArtifactV2{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))}
	matrix.Rows[0].Evidence = &evidence
	result = ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}))
	if result.Code != "artifact_path_mismatch" {
		t.Fatalf("nested file was accepted: %+v", result)
	}
	for depth := 2; depth <= externalRootMaxDepth; depth++ {
		root = t.TempDir()
		parts := make([]string, depth-1)
		for index := range parts {
			parts[index] = "d" + strconv.Itoa(index+1)
		}
		parts = append(parts, "proof.txt")
		path := filepath.Join(append([]string{root}, parts[:len(parts)-1]...)...)
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, parts[len(parts)-1]), data, 0600); err != nil {
			t.Fatal(err)
		}
		inventory = writeV2Inventory(t, root)
		evidence = v2Evidence(strings.Join(parts, "/"), data, inventory)
		matrix = v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
		result = ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}))
		if result.Status != "valid" || result.Code != "observed" {
			t.Fatalf("referenced depth %d rejected: %+v", depth, result)
		}
	}
	root = t.TempDir()
	parts := make([]string, externalRootMaxDepth)
	for index := range parts {
		parts[index] = "d" + strconv.Itoa(index+1)
	}
	path := filepath.Join(append([]string{root}, parts...)...)
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "proof.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	opened, err := OpenExternalEvidenceRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InventoryExternalEvidenceRoot(opened); err == nil || err.(*ExternalEvidenceError).Code != "evidence_path_invalid" {
		t.Fatalf("depth-11 path was accepted: %v", err)
	}
	root = t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	evidence = v2Evidence("proof.txt", data, nil)
	evidence.Artifacts = evidence.Artifacts[:1]
	matrix = v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	result = ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}))
	if result.Code != "artifact_path_mismatch" {
		t.Fatalf("missing inventory was accepted: %+v", result)
	}
}
func TestAcceptanceV2InventoryReportIsCanonicalAndBound(t *testing.T) {
	root := t.TempDir()
	proof := []byte("proof")
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), proof, 0600); err != nil {
		t.Fatal(err)
	}
	report := writeV2Inventory(t, root)
	computedRoot, err := OpenExternalEvidenceRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	computed, err := InventoryExternalEvidenceRoot(computedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if parsed, ok := parseExternalEvidenceInventoryReport(report); !ok || !externalInventoryEqual(parsed, computed) {
		t.Fatal("canonical inventory report did not round-trip")
	}
	for _, malformed := range [][]byte{[]byte("not an inventory"),
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[],"extra":true}`), []byte(`{"version":1,"format":"pi-sampler.external-evidence-inventory/v1","entries":[]}
`), []byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[],"entries":[]}; `),
	} {
		if _, ok := parseExternalEvidenceInventoryReport(malformed); ok {
			t.Fatalf("malformed inventory report accepted: %q", malformed)
		}
	}
	if len(computed.Entries) != 1 || computed.Entries[0].Path != "proof.txt" {
		t.Fatalf("unexpected computed inventory: %+v", computed)
	}
	matrix := v2Matrix("implementation-delivery", "ordinary", nil, nil)
	policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
	for _, malformed := range [][]byte{
		[]byte("not an inventory"),
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[]}`),
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[],"extra":true}`),
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[{"path":"proof.txt","type":"file","bytes":6,"identity":"forged","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}; `)} {
		if err := os.WriteFile(filepath.Join(root, AcceptanceV2InventoryReportName), malformed, 0600); err != nil {
			t.Fatal(err)
		}
		evidence := v2Evidence("proof.txt", proof, malformed)
		matrix.Rows[0].Evidence = &evidence
		result := ValidateAcceptanceV2(v2Request(matrix, root, policy))
		if result.Code != "matrix_schema_invalid" {
			t.Fatalf("malformed inventory report accepted: %+v", result)
		}
	}
}
func TestAcceptanceV2SharedPublicationArtifactsRemainClosedWorld(t *testing.T) {
	root := t.TempDir()
	validator, review := []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved\n")
	if err := os.WriteFile(filepath.Join(root, "plan-validator-report.json"), validator, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), review, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	shared := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: []AcceptanceArtifactV2{
		{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))}, {Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))}, {Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))}}}
	matrix := v2Matrix("plan-publication", "authority", &shared, nil)
	second := matrix.Rows[0]
	second.ID = "AIDEV-191-2"
	matrix.Rows = append(matrix.Rows, second)
	result := ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{}))
	if result.Status != "valid" || result.Code != "specified" || len(result.Rows) != 2 {
		t.Fatalf("shared publication artifacts rejected: %+v", result)
	}
	shared.Artifacts[1].Path = "plan-validator-report.json"
	matrix.Rows[1].Specification = &shared
	if result = ValidateAcceptanceV2(v2Request(matrix, root, AcceptancePolicyV2{})); result.Code != "artifact_path_mismatch" && result.Code != "matrix_schema_invalid" {
		t.Fatalf("conflicting shared artifact accepted: %+v", result)
	}
}
func TestAcceptanceV2UTF8ByteContractCoversReasonAndArgv(t *testing.T) {
	root := t.TempDir()
	proof := []byte("proof")
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), proof, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := v2Evidence("proof.txt", proof, inventory)
	evidence.Verifier.Argv = []string{strings.Repeat("é", 128)}
	matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	matrix.Rows[0].Requirement = strings.Repeat("é", 1024)
	policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: evidence.Verifier.Argv, Version: "v1"}}}
	if result := ValidateAcceptanceV2(v2Request(matrix, root, policy)); result.Status != "valid" {
		t.Fatalf("multibyte exact-limit fields rejected: %+v", result)
	}
	evidence.Verifier.Argv = []string{strings.Repeat("é", 129)}
	matrix.Rows[0].Evidence = &evidence
	policy.Classes[0].Command = evidence.Verifier.Argv
	if result := ValidateAcceptanceV2(v2Request(matrix, root, policy)); result.Code != "matrix_schema_invalid" {
		t.Fatalf("argv byte limit not enforced: %+v", result)
	}
	blocked := v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: strings.Repeat("é", 1024), BlockedBy: nil})
	empty := t.TempDir()
	if result := ValidateAcceptanceV2(v2Request(blocked, empty, AcceptancePolicyV2{})); result.Status != "blocked" {
		t.Fatalf("multibyte exact-limit reason rejected: %+v", result)
	}
}
func TestAcceptanceV2PortablePathCorpus(t *testing.T) {
	data, err := os.ReadFile("../../docs/delivery-evidence/acceptance-matrix-v2.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Corpus []struct {
			Value string `json:"value"`
			Valid bool   `json:"valid"`
		} `json:"x-portable-path-corpus"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Corpus) == 0 {
		t.Fatal("shared portable-path corpus is empty")
	}
	for _, entry := range document.Corpus {
		if actual := validV2ArtifactPath(entry.Value); actual != entry.Valid {
			t.Errorf("portable path %q: runtime=%v schema corpus=%v", entry.Value, actual, entry.Valid)
		}
	}
	if !validV2PortablePath(strings.Repeat("a", 255), 256) || validV2PortablePath(strings.Repeat("a", 256), 256) {
		t.Fatal("portable path component boundary diverges from schema")
	}
}
func TestAcceptanceV2ArtifactNameCorpus(t *testing.T) {
	data, err := os.ReadFile("../../docs/delivery-evidence/acceptance-matrix-v2.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Corpus []struct {
			Value    string   `json:"value"`
			Repeat   int      `json:"repeat"`
			Suffix   string   `json:"suffix"`
			Encoding string   `json:"encoding"`
			BytesHex string   `json:"bytes_hex"`
			Values   []string `json:"values"`
			Kind     string   `json:"kind"`
			Platform string   `json:"platform"`
			Valid    bool     `json:"valid"`
		} `json:"x-artifact-name-corpus"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Corpus) == 0 {
		t.Fatal("shared artifact-name corpus is empty")
	}
	for _, entry := range document.Corpus {
		if entry.Encoding == "invalid-utf8" {
			raw, err := hex.DecodeString(entry.BytesHex)
			if err != nil {
				t.Fatal(err)
			}
			if actual := validDefault(string(raw), 128); actual != entry.Valid {
				t.Errorf("invalid UTF-8 artifact name: runtime=%v corpus=%v", actual, entry.Valid)
			}
			continue
		}
		if len(entry.Values) > 0 {
			actual := true
			seen := map[string]bool{}
			for _, value := range entry.Values {
				key := externalIdentityKey(value)
				if !validDefault(value, 128) || seen[key] {
					actual = false
				}
				seen[key] = true
			}
			expected := entry.Valid
			if entry.Platform == "windows" && runtime.GOOS != "windows" {
				expected = true
			}
			if actual != expected {
				t.Errorf("artifact-name %s: runtime=%v corpus=%v", entry.Kind, actual, expected)
			}
			continue
		}
		repeat := entry.Repeat
		if repeat == 0 {
			repeat = 1
		}
		value := strings.Repeat(entry.Value, repeat) + entry.Suffix
		if actual := validDefault(value, 128); actual != entry.Valid {
			t.Errorf("artifact name %q: runtime=%v corpus=%v", value, actual, entry.Valid)
		}
	}
	root := t.TempDir()
	proof := []byte("proof")
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), proof, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := v2Evidence("proof.txt", proof, inventory)
	evidence.Artifacts[0].Name = "name with spaces"
	matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
	if result := ValidateAcceptanceV2(v2Request(matrix, root, policy)); result.Status != "valid" {
		t.Fatalf("contract-valid logical artifact name rejected: %+v", result)
	}
}
func TestAcceptanceV2IncrementalEnumerationGuard(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "entry")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	_, err = collectExternalEntries(func() ([]os.FileInfo, error) {
		calls++
		if calls <= externalRootMaxEntries+1 {
			return []os.FileInfo{info}, nil
		}
		return nil, io.EOF
	})
	if err == nil {
		t.Fatal("enumeration bound did not reject entry 1001")
	}
	if externalErr, ok := err.(*ExternalEvidenceError); !ok || externalErr.Code != "artifact_too_large" || calls != externalRootMaxEntries+1 {
		t.Fatalf("unexpected bounded enumeration result: %v calls=%d", err, calls)
	}
}
func TestAcceptanceV2ExternalExclusionsAndIncrementalBound(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Dir(root)
	if _, err := OpenExternalEvidenceRoot(root, parent); err == nil {
		t.Fatal("ancestor exclusion was accepted")
	}
	excluded := t.TempDir()
	if _, err := OpenExternalEvidenceRoot(root, excluded); err != nil {
		t.Fatalf("unrelated exclusion rejected: %v", err)
	}
	large := t.TempDir()
	for index := 0; index < externalRootMaxEntries+1; index++ {
		if err := os.WriteFile(filepath.Join(large, "f"+strconv.Itoa(index)), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	opened, err := OpenExternalEvidenceRoot(large)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InventoryExternalEvidenceRoot(opened); err == nil || err.(*ExternalEvidenceError).Code != "artifact_too_large" {
		t.Fatalf("large directory result: %v", err)
	}
}
func TestAcceptanceV2WindowsIdentityComparisonPrimitive(t *testing.T) {
	low := externalIdentity{Device: 0x00000001, File: 7, FileHigh: 9, HasDevice: true, HasFile: true, HasFile128: true, Type: 1}
	high := low
	high.Device = 0x100000001
	if externalAncestorIdentitiesEqual(low, high) {
		t.Fatal("distinct 64-bit volume serials aliased")
	}
	if !externalAncestorIdentitiesEqual(low, low) {
		t.Fatal("equal FILE_ID_INFO identity rejected")
	}
}
func TestAcceptanceV2RequestIsBoundedAndSingleFramed(t *testing.T) {
	root := t.TempDir()
	data := []byte("proof")
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := v2Evidence("proof.txt", data, inventory)
	matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	request := v2Request(matrix, root, AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}})
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeAcceptanceV2Request(encoded); err != nil {
		t.Fatalf("bounded request rejected: %v", err)
	}
	if _, err := DecodeAcceptanceV2Request(append(encoded, []byte("\n{}")...)); err == nil {
		t.Fatal("multiple request frames accepted")
	}
	if _, err := DecodeAcceptanceV2Request(append(bytes.Repeat([]byte{' '}, 12*1024*1024+1), '{')); err == nil {
		t.Fatal("limit+1 request accepted")
	}
}
func assertPublicResultRows(t *testing.T, result AcceptanceResultV1, status, code string, count int) {
	t.Helper()
	if result.Status != status || result.Code != code || len(result.Rows) != count {
		t.Fatalf("public result mismatch: got status=%q code=%q rows=%d want status=%q code=%q rows=%d: %+v", result.Status, result.Code, len(result.Rows), status, code, count, result)
	}
	for index, row := range result.Rows {
		wantStatus, wantCode := status, code
		if status == "valid" {
			wantStatus, wantCode = "valid", "specified"
		}
		if row.Status != wantStatus || row.Code != wantCode {
			t.Errorf("row %d: got=%+v want status=%q code=%q", index, row, wantStatus, wantCode)
		}
	}
}

func assertV2DiagnosticCodes(t *testing.T, result AcceptanceResultV1, codes ...string) {
	t.Helper()
	for _, code := range codes {
		if !hasV2Diagnostic(result, code) {
			t.Errorf("diagnostic %q missing from %+v", code, result.Diagnostics)
		}
	}
}

type expectedV2Diagnostic struct {
	code string
	path string
}

func assertV2DiagnosticsExact(t *testing.T, result AcceptanceResultV1, want ...expectedV2Diagnostic) {
	t.Helper()
	if len(result.Diagnostics) != len(want) {
		t.Fatalf("diagnostic count mismatch: got=%+v want=%+v", result.Diagnostics, want)
	}
	for index, expected := range want {
		got := result.Diagnostics[index]
		if got.Code != expected.code || got.Path != expected.path {
			t.Fatalf("diagnostic %d mismatch: got=%+v want code=%q path=%q", index, got, expected.code, expected.path)
		}
	}
}

func cloneV2RowForTest(t *testing.T, row AcceptanceMatrixV2Row) AcceptanceMatrixV2Row {
	t.Helper()
	data, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var cloned AcceptanceMatrixV2Row
	if err := json.Unmarshal(data, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}

func decodeV2MatrixForTest(t *testing.T, request AcceptanceV2Request) AcceptanceMatrixV2 {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(request.MatrixBase64)
	if err != nil {
		t.Fatal(err)
	}
	var matrix AcceptanceMatrixV2
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	return matrix
}

func requestWithExactV2Matrix(request AcceptanceV2Request, matrix AcceptanceMatrixV2) AcceptanceV2Request {
	request.NormalizedFacts = v2Facts(matrix)
	request.FactsSHA256 = normalizedFactsDigestV1(request.NormalizedFacts)
	return requestWithV2Matrix(request, matrix)
}

func publicationV2MultiRowRequest(t *testing.T, validator, review []byte) (AcceptanceV2Request, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "plan-validator-report.json"), validator, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), review, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: []AcceptanceArtifactV2{
		{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))},
		{Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))},
		{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))},
	}}
	matrix := v2Matrix("plan-publication", "authority", &evidence, nil)
	second := cloneV2RowForTest(t, matrix.Rows[0])
	second.ID = "AIDEV-191-2"
	matrix.Rows = append(matrix.Rows, second)
	return v2Request(matrix, root, AcceptancePolicyV2{}), root
}

func implementationV2MultiRowRequest(t *testing.T) (AcceptanceV2Request, string) {
	t.Helper()
	root := t.TempDir()
	data := []byte("implementation proof")
	if err := os.WriteFile(filepath.Join(root, "proof.txt"), data, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	evidence := v2Evidence("proof.txt", data, inventory)
	matrix := v2Matrix("implementation-delivery", "ordinary", &evidence, nil)
	second := cloneV2RowForTest(t, matrix.Rows[0])
	second.ID = "AIDEV-191-2"
	matrix.Rows = append(matrix.Rows, second)
	policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
	return v2Request(matrix, root, policy), root
}

func windowsCommandPathIsSafe(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value && !strings.ContainsAny(value, "\x00\r\n\"&|<>^()%!*")
}

func createWindowsJunction(t *testing.T, fsutil, link, target string) {
	if !windowsCommandPathIsSafe(link) || !windowsCommandPathIsSafe(target) {
		t.Fatal("unsafe path")
	}
	output, err := runWindowsTestCommand(t, "cmd.exe", "/d", "/c", "mklink", "/J", link, target)
	requireWindowsCommandCapability(t, "create directory junction", output, err)
	verifyWindowsJunction(t, fsutil, link, target)
}

func verifyWindowsJunction(t *testing.T, fsutil, link, target string) {
	output, err := runWindowsTestCommand(t, fsutil, "reparsepoint", "query", link)
	if err != nil {
		t.Fatalf("junction query failed: %v output=%q", err, output)
	}
	expectedTarget := filepath.Clean(target)
	output = strings.ReplaceAll(output, "\r\n", "\n")
	for _, want := range []string{
		"Reparse Tag Value : 0xa0000003",
		"Substitute Name:       \\??\\" + expectedTarget,
		"Print Name:            " + expectedTarget,
	} {
		if !strings.Contains("\n"+output, "\n"+want+"\n") {
			t.Fatalf("junction output lacked exact line %q: %q", want, output)
		}
	}
}

func removeWindowsJunction(t *testing.T, link string) {
	if err := os.Remove(link); err != nil && !os.IsNotExist(err) {
		t.Errorf("junction cleanup failed: %v", err)
	}
}

func runWindowsExternalEvidenceAdversaries(t *testing.T) {
	t.Helper()
	t.Run("real file symlink rejection", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(root, "file-symlink.txt")
		if err := os.Symlink("proof.txt", link); err != nil {
			t.Skipf("blocked/windows_capability_unavailable: file symlink creation: %v", err)
		}
		if target, err := os.Readlink(link); err != nil || target == "" {
			t.Fatalf("symlink fixture was not an actual link: target=%q err=%v", target, err)
		}
		linked := artifact
		linked.Path = "file-symlink.txt"
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, linked)
			return err
		}(), "evidence_path_invalid")
	})
	t.Run("real hard-link rejection", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(root, "hard-link.txt")
		if err := os.Link(filepath.Join(root, "proof.txt"), link); err != nil {
			t.Skipf("blocked/windows_capability_unavailable: hard-link creation: %v", err)
		}
		if source, linked := fileInfoForTest(t, filepath.Join(root, "proof.txt")), fileInfoForTest(t, link); !os.SameFile(source, linked) {
			t.Fatalf("hard-link fixture is not the same filesystem object: source=%v linked=%v", source, linked)
		}
		linked := artifact
		linked.Path = "hard-link.txt"
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, linked)
			return err
		}(), "evidence_path_invalid")
	})
	t.Run("real ADS path and stream rejection", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		streamPath := filepath.Join(root, "proof.txt") + ":aidev200-stream"
		if err := os.WriteFile(streamPath, data, 0600); err != nil {
			t.Skipf("blocked/windows_capability_unavailable: ADS creation: %v", err)
		}
		info, err := os.Stat(streamPath)
		if err != nil {
			t.Skipf("blocked/windows_capability_unavailable: ADS stat: %v", err)
		}
		if info.Size() != int64(len(data)) {
			t.Fatalf("ADS stream was not materialized: size=%v", info.Size())
		}
		stream := artifact
		stream.Path = "proof.txt:aidev200-stream"
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, stream)
			return err
		}(), "evidence_path_invalid")
	})
	t.Run("real sparse artifact rejection", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "sparse.bin")
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
		fsutil, err := exec.LookPath("fsutil.exe")
		if err != nil {
			t.Skipf("blocked/windows_capability_unavailable: fsutil.exe unavailable: %v", err)
		}
		output, err := runWindowsTestCommand(t, fsutil, "sparse", "setflag", path)
		requireWindowsCommandCapability(t, "mark sparse", output, err)
		output, err = runWindowsTestCommand(t, fsutil, "sparse", "queryflag", path)
		requireWindowsCommandCapability(t, "query sparse flag", output, err)
		if !strings.Contains(strings.ToLower(output), "sparse") {
			t.Skipf("blocked/windows_capability_unavailable: sparse query did not identify a sparse artifact: %q", output)
		}
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		artifact := AcceptanceArtifactV2{Name: "sparse.bin", Path: "sparse.bin", SHA256: fileSHA256(nil), Bytes: 0}
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, artifact)
			return err
		}(), "evidence_path_invalid")
	})
	t.Run("real directory junction/reparse rejection", func(t *testing.T) {
		fsutil, err := exec.LookPath("fsutil.exe")
		if err != nil {
			t.Skipf("blocked/windows_capability_unavailable: fsutil.exe unavailable: %v", err)
		}
		parent := t.TempDir()
		target := filepath.Join(parent, "junction-target")
		if err := os.Mkdir(target, 0700); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(parent, "junction-root")
		createWindowsJunction(t, fsutil, link, target)
		t.Cleanup(func() { removeWindowsJunction(t, link) })
		_, err = OpenExternalEvidenceRoot(link)
		assertExternalErrorCode(t, err, "evidence_root_invalid")
		removeWindowsJunction(t, link)

		root := t.TempDir()
		data := []byte("trusted")
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(outside, "proof.txt"), data, 0600); err != nil {
			t.Fatal(err)
		}
		insideLink := filepath.Join(root, "junction")
		createWindowsJunction(t, fsutil, insideLink, outside)
		t.Cleanup(func() { removeWindowsJunction(t, insideLink) })
		artifact := AcceptanceArtifactV2{Name: "proof.txt", Path: "junction/proof.txt", SHA256: fileSHA256(data), Bytes: int64(len(data))}
		_, err = ReadVerifiedArtifact(opened, artifact)
		assertExternalErrorCode(t, err, "evidence_identity_changed")
		removeWindowsJunction(t, insideLink)
	})
	t.Run("cmd path metacharacters fail closed before invocation", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target")
		for _, metacharacter := range []string{"&", "|", "<", ">", "^", "(", ")", "%", "!"} {
			link := filepath.Join(root, "junction"+metacharacter+"ver")
			if windowsCommandPathIsSafe(link) || windowsCommandPathIsSafe(target+metacharacter) {
				t.Fatalf("metacharacter %q passed the complete cmd.exe path policy", metacharacter)
			}
		}
	})
	t.Run("real Windows final-handle root-swap race", func(t *testing.T) {
		root := t.TempDir()
		trusted := bytes.Repeat([]byte{'T'}, 4*1024*1024)
		attack := bytes.Repeat([]byte{'A'}, len(trusted))
		artifact := writeExternalTestArtifact(t, root, "proof.txt", trusted)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		stop := make(chan struct{})
		var stopOnce sync.Once
		var wg sync.WaitGroup
		stopWorkers := func() {
			stopOnce.Do(func() { close(stop) })
			wg.Wait()
		}
		defer stopWorkers()
		var swapOnce sync.Once
		swapped := make(chan struct{})
		errCh := make(chan error, 1)
		recordError := func(err error) {
			select {
			case errCh <- err:
			default:
			}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := 0; index < 256; index++ {
				select {
				case <-stop:
					return
				default:
				}
				backup := filepath.Join(filepath.Dir(root), filepath.Base(root)+"-swap-"+strconv.Itoa(index))
				if err := os.Rename(root, backup); err != nil {
					continue
				}
				swapOnce.Do(func() { close(swapped) })
				if err := os.Mkdir(root, 0700); err != nil {
					recordError(err)
					return
				}
				if err := os.WriteFile(filepath.Join(root, "proof.txt"), attack, 0600); err != nil {
					recordError(err)
					return
				}
				_ = os.RemoveAll(backup)
			}
		}()
		observed := false
		for index := 0; index < 256; index++ {
			select {
			case <-swapped:
				observed = true
			default:
			}
			got, readErr := ReadVerifiedArtifact(opened, artifact)
			if readErr != nil {
				if observed {
					assertExternalErrorCodeOneOf(t, readErr, "evidence_identity_changed", "evidence_path_invalid", "evidence_root_invalid")
					stopWorkers()
					return
				}
				continue
			}
			if !bytes.Equal(got, trusted) {
				stopWorkers()
				t.Fatal("Windows root-swap race accepted attack bytes")
			}
		}
		select {
		case <-swapped:
			observed = true
		default:
		}
		stopWorkers()
		select {
		case writeErr := <-errCh:
			t.Fatalf("Windows root-swap writer failed: %v", writeErr)
		default:
		}
		if !observed {
			t.Skip("blocked/windows_capability_unavailable: root-swap race did not acquire a replacement window")
		}
	})
}

func TestSignedWaiverRequiresExternalTrustAndSingleUseReplayState(t *testing.T) {
	repositoryRoot := t.TempDir()
	copyPublishedSchemas(t, repositoryRoot)
	operatorRoot := t.TempDir()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	base, head, plan := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 64)
	now := time.Now().UTC()
	waiver := DeliveryWaiver{SchemaVersion: WaiverSchemaVersion, WaiverID: "waiver-aidev999-test", Issuer: "operator", KeyID: "operator-key", Repository: "Zkrausman/pi-sampler", TicketID: "AIDEV-999", PullRequest: WaiverPullRequest{Number: 42, BaseSHA: base, HeadSHA: head}, RowID: "A999-T01", PlanSHA256: plan, Rationale: "external owner approved the temporary exception", Issue: "AIDEV-133", Nonce: strings.Repeat("n", 32), IssuedAt: now.Add(-time.Second).Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano), RevocationRef: "rev-1"}
	payload, err := canonicalWaiverBytes(waiver)
	if err != nil {
		t.Fatal(err)
	}
	waiver.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	waiverPath := filepath.Join(operatorRoot, "waiver.json")
	trustPath := filepath.Join(operatorRoot, "trust.json")
	replayPath := filepath.Join(operatorRoot, "replay.json")
	waiverData, _ := json.Marshal(waiver)
	if err := os.WriteFile(waiverPath, waiverData, 0600); err != nil {
		t.Fatal(err)
	}
	config := TrustedWaiverConfig{SchemaVersion: WaiverTrustSchemaVersion, Keys: []TrustedWaiverKey{{KeyID: "operator-key", Issuer: "operator", Algorithm: "ed25519", PublicKey: base64.StdEncoding.EncodeToString(der)}}, RevokedRefs: []string{}}
	configData, _ := json.Marshal(config)
	if err := os.WriteFile(trustPath, configData, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"Zkrausman/pi-sampler", "AIDEV-999", "A999-T01", plan, base, head}
	if err := ValidateWaiverFile(waiverPath, trustPath, replayPath, repositoryRoot, args[0], args[1], args[2], args[3], args[4], args[5], 42); err != nil {
		t.Fatal(err)
	}
	if err := ValidateWaiverFile(waiverPath, trustPath, replayPath, repositoryRoot, args[0], args[1], args[2], args[3], args[4], args[5], 42); err == nil || !strings.Contains(err.Error(), "consumed") {
		t.Fatalf("replayed waiver was not rejected: %v", err)
	}
}

func assertJSONKeysInOrder(t *testing.T, data []byte, keys []string) {
	t.Helper()
	previous := -1
	for _, key := range keys {
		marker := []byte(`"` + key + `":`)
		index := bytes.Index(data, marker)
		if index <= previous {
			t.Fatalf("JSON key %q is out of order or absent in %s", key, data)
		}
		previous = index
	}
}

func requestWithV2Matrix(request AcceptanceV2Request, matrix AcceptanceMatrixV2) AcceptanceV2Request {
	request.MatrixBase64 = base64.StdEncoding.EncodeToString(canonicalAcceptanceMatrixV2Bytes(matrix))
	return request
}

func assertV2Rows(t *testing.T, result AcceptanceResultV1, statuses, codes []string) {
	t.Helper()
	if len(result.Rows) != len(statuses) || len(result.Rows) != len(codes) {
		t.Fatalf("row count mismatch: got=%+v statuses=%v codes=%v", result.Rows, statuses, codes)
	}
	for index, row := range result.Rows {
		if row.Status != statuses[index] || row.Code != codes[index] {
			t.Errorf("row %d: got=%+v want status=%q code=%q", index, row, statuses[index], codes[index])
		}
	}
}

func hasV2Diagnostic(result AcceptanceResultV1, code string) bool {
	for _, diagnostic := range result.Diagnostics {
		if diagnostic.Code == code {
			return true
		}
	}
	return false
}

func TestAcceptanceV2CanonicalWireVectors(t *testing.T) {
	separator := string(rune(0x2028))
	paragraph := string(rune(0x2029))
	requirement := "line" + separator + "next" + paragraph + " literal \\u2028 \\u2029 quote \" slash \\\\ tab\t"
	blockedBy := "AIDEV-191-1"
	matrix := v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{
		Code:      "blocked",
		Reason:    requirement,
		BlockedBy: &blockedBy,
	})
	matrix.Rows[0].Requirement = requirement
	facts := v2Facts(matrix)
	result := AcceptanceResultV1{
		Format:          AcceptanceResultV1Format,
		Version:         AcceptanceResultV1Version,
		Status:          "blocked",
		Code:            "rows_blocked",
		EvaluationScope: "implementation-delivery",
		FactsSHA256:     strings.Repeat("d", 64),
		MatrixSHA256:    strings.Repeat("e", 64),
		Rows:            []AcceptanceResultV1Row{{ID: "AIDEV-191-1", Status: "blocked", Code: "blocked"}},
		Diagnostics:     []AcceptanceDiagnosticV1{{Code: "rows_blocked", Path: "/rows"}},
	}

	wantRow := `{"id":"AIDEV-191-1","acceptance_class":"ordinary","requirement":"line` + separator + `next` + paragraph + ` literal \\u2028 \\u2029 quote \" slash \\\\ tab\t","status":"blocked","blocker":{"code":"blocked","reason":"line` + separator + `next` + paragraph + ` literal \\u2028 \\u2029 quote \" slash \\\\ tab\t","blocked_by":"AIDEV-191-1"}}`
	if got := string(canonicalAcceptanceRowBytes(matrix.Rows[0], matrix.EvaluationScope)); got != wantRow {
		t.Fatalf("canonical row mismatch:\n got %q\nwant %q", got, wantRow)
	}
	matrixBytes := CanonicalAcceptanceMatrixV2(matrix)
	factsBytes := CanonicalNormalizedFactsV1(facts)
	resultBytes := CanonicalAcceptanceResultV1(result)
	for name, data := range map[string][]byte{"matrix": matrixBytes, "facts": factsBytes, "result": resultBytes} {
		if !utf8.Valid(data) || !bytes.HasSuffix(data, []byte("\n")) || bytes.Count(data, []byte("\n")) != 1 {
			t.Fatalf("%s wire vector is not one valid LF-framed UTF-8 value: %q", name, data)
		}
	}
	if !bytes.Contains(matrixBytes, []byte(separator)) || !bytes.Contains(matrixBytes, []byte(paragraph)) {
		t.Fatal("matrix vector lost literal U+2028/U+2029")
	}
	if !bytes.Contains(matrixBytes, []byte(`\\u2028`)) || !bytes.Contains(matrixBytes, []byte(`\\u2029`)) {
		t.Fatal("matrix vector rewrote literal backslash-u text")
	}
	if !bytes.Contains(matrixBytes, []byte(`\"`)) || !bytes.Contains(matrixBytes, []byte(`\\\\`)) || !bytes.Contains(matrixBytes, []byte(`\t`)) {
		t.Fatal("matrix vector did not preserve ordinary JSON escapes")
	}
	assertJSONKeysInOrder(t, matrixBytes, []string{
		"schema_version", "manifest_schema_version", "evaluation_scope", "repository", "ticket_id", "ticket_revision",
		"profile_path", "profile_sha256", "base_sha", "head_sha", "pull_request_number", "plan_path", "plan_sha256",
		"manifest_path", "manifest_sha256", "manifest_contract_path", "manifest_contract_sha256", "manifest_validator_path",
		"manifest_validator_sha256", "matrix_contract_path", "matrix_contract_sha256", "policy_path", "policy_sha256",
		"evidence_root_id", "generated_at", "rows",
	})
	assertJSONKeysInOrder(t, factsBytes, []string{
		"format", "version", "repository", "ticketId", "ticketRevision", "profilePath", "profileSha256", "baseSha",
		"headSha", "pullRequestNumber", "planPath", "planSha256", "manifestPath", "manifestSha256", "manifestSchemaVersion",
		"manifestContractSha256", "manifestValidatorSha256", "matrixContractSha256", "policySha256", "evaluationScope", "rows",
	})
	assertJSONKeysInOrder(t, resultBytes, []string{
		"format", "version", "status", "code", "evaluation_scope", "facts_sha256", "matrix_sha256", "rows", "diagnostics",
	})
	wantResult := `{"format":"pi-sampler.delivery-acceptance-result","version":1,"status":"blocked","code":"rows_blocked","evaluation_scope":"implementation-delivery","facts_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","matrix_sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","rows":[{"id":"AIDEV-191-1","status":"blocked","code":"blocked"}],"diagnostics":[{"code":"rows_blocked","path":"/rows"}]}` + "\n"
	if string(resultBytes) != wantResult {
		t.Fatalf("canonical result vector mismatch:\n got %q\nwant %q", resultBytes, wantResult)
	}
	if got := NormalizedFactsSHA256V1(facts); got != "e683a1456dad29f6516c0ab7edd6f00294bd4fd335d41b00ea7fc42e19dd9bc1" {
		t.Fatalf("normalized-facts domain digest changed: %s", got)
	}
	marshaled, err := matrix.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(marshaled, bytes.TrimSuffix(matrixBytes, []byte("\n"))) {
		t.Fatal("matrix MarshalJSON does not share the canonical wire vector")
	}
}

func TestAcceptanceV2StrictMatrixSchemaAndLegacyBoundary(t *testing.T) {
	data, err := os.ReadFile("../../docs/delivery-evidence/acceptance-matrix-v2.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	wantRequired := []string{
		"schema_version", "manifest_schema_version", "evaluation_scope", "repository", "ticket_id", "ticket_revision",
		"profile_path", "profile_sha256", "base_sha", "head_sha", "pull_request_number", "plan_path", "plan_sha256",
		"manifest_path", "manifest_sha256", "manifest_contract_path", "manifest_contract_sha256", "manifest_validator_path",
		"manifest_validator_sha256", "matrix_contract_path", "matrix_contract_sha256", "policy_path", "policy_sha256",
		"evidence_root_id", "generated_at", "rows",
	}
	if len(schema.Required) != len(wantRequired) {
		t.Fatalf("root required set changed: %v", schema.Required)
	}
	for index := range wantRequired {
		if schema.Required[index] != wantRequired[index] {
			t.Fatalf("root required[%d]=%q want %q", index, schema.Required[index], wantRequired[index])
		}
	}

	matrix := v2Matrix("implementation-delivery", "ordinary", nil, &AcceptanceBlockerV2{Code: "blocked", Reason: "strict"})
	canonical := canonicalAcceptanceMatrixV2Bytes(matrix)
	root := t.TempDir()
	cases := []struct {
		name string
		data []byte
		code string
	}{
		{"duplicate root key", bytes.Replace(canonical, []byte(`"schema_version":"acceptance-matrix/v2"`), []byte(`"schema_version":"acceptance-matrix/v2","schema_version":"acceptance-matrix/v2"`), 1), "matrix_duplicate_key"},
		{"unknown root key", bytes.Replace(canonical, []byte(`"evaluation_scope":"implementation-delivery"`), []byte(`"evaluation_scope":"implementation-delivery","unknown":true`), 1), "matrix_schema_invalid"},
		{"unknown row key", bytes.Replace(canonical, []byte(`"status":"blocked","blocker"`), []byte(`"status":"blocked","unknown":true,"blocker"`), 1), "matrix_schema_invalid"},
		{"legacy waiver field", bytes.Replace(canonical, []byte(`"status":"blocked","blocker"`), []byte(`"status":"blocked","waiver":{"format":"delivery-waiver/v1"},"blocker"`), 1), "matrix_schema_invalid"},
		{"leading whitespace", append([]byte{' '}, canonical...), "matrix_noncanonical"},
		{"trailing whitespace", append(append([]byte(nil), canonical...), ' '), "matrix_noncanonical"},
		{"reordered root keys", bytes.Replace(canonical, []byte(`{"schema_version":"acceptance-matrix/v2","manifest_schema_version":"implementation-plan-manifest/v2"`), []byte(`{"manifest_schema_version":"implementation-plan-manifest/v2","schema_version":"acceptance-matrix/v2"`), 1), "matrix_noncanonical"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := v2Request(matrix, root, AcceptancePolicyV2{})
			request.MatrixBase64 = base64.StdEncoding.EncodeToString(tc.data)
			result := ValidateAcceptanceV2(request)
			if result.Code != tc.code || result.Status != "invalid" {
				t.Fatalf("got %+v want invalid/%s", result, tc.code)
			}
		})
	}
}

func TestAcceptanceV2PublicationRowsUseExactInvalidTopLevelCode(t *testing.T) {
	matrix := v2Matrix("plan-publication", "authority", nil, nil)
	second := matrix.Rows[0]
	second.ID = "AIDEV-191-2"
	matrix.Rows = append(matrix.Rows, second)
	facts := v2Facts(matrix)
	invalidCodes := strings.Fields("usage_invalid git_unavailable trusted_base_invalid activation_absent trusted_blob_invalid trusted_digest_mismatch candidate_root_invalid source_mutated artifact_too_large manifest_validator_failed manifest_version_unsupported matrix_duplicate_key matrix_json_invalid matrix_schema_invalid matrix_noncanonical version_pair_mixed version_pair_unsupported binding_mismatch artifact_path_mismatch digest_mismatch row_duplicate row_missing row_unknown row_reordered row_binding_mismatch scope_status_mismatch evidence_root_invalid evidence_path_invalid evidence_identity_changed artifact_digest_mismatch policy_missing policy_ambiguous verifier_policy_mismatch")
	for _, code := range invalidCodes {
		t.Run(code, func(t *testing.T) {
			diagnostics := newV2Diagnostics()
			diagnostics.add(code, "/test")
			result := finishV2Result(AcceptanceResultV1{}, facts, diagnostics, &matrix)
			if result.Status != "invalid" || result.Code != code {
				t.Fatalf("got %+v want invalid/%s", result, code)
			}
			assertV2Rows(t, result, []string{"invalid", "invalid"}, []string{code, code})
		})
	}
	precedence := newV2Diagnostics()
	precedence.add("source_mutated", "/evidence_root")
	precedence.add("digest_mismatch", "/facts_sha256")
	precedenceResult := finishV2Result(AcceptanceResultV1{}, facts, precedence, &matrix)
	if precedenceResult.Code != "source_mutated" {
		t.Fatalf("source-mutation/digest precedence changed: %+v", precedenceResult)
	}
	valid := finishV2Result(AcceptanceResultV1{}, facts, newV2Diagnostics(), &matrix)
	if valid.Status != "valid" || valid.Code != "specified" {
		t.Fatalf("valid publication finalization changed: %+v", valid)
	}
	assertV2Rows(t, valid, []string{"valid", "valid"}, []string{"specified", "specified"})
}

func TestAcceptanceV2ImplementationRowFinalizationKeepsBlockedAndUnsupportedSemantics(t *testing.T) {
	matrix := v2Matrix("implementation-delivery", "ordinary", nil, nil)
	second := matrix.Rows[0]
	second.ID = "AIDEV-191-2"
	matrix.Rows = append(matrix.Rows, second)
	facts := v2Facts(matrix)
	valid := finishV2Result(AcceptanceResultV1{}, facts, newV2Diagnostics(), &matrix)
	if valid.Status != "valid" || valid.Code != "observed" {
		t.Fatalf("valid implementation finalization changed: %+v", valid)
	}
	assertV2Rows(t, valid, []string{"valid", "valid"}, []string{"observed", "observed"})

	blocked := matrix
	blocked.Rows[1].Status = "blocked"
	blocked.Rows[1].Blocker = &AcceptanceBlockerV2{Code: "blocked", Reason: "not activated"}
	blockedDiagnostics := newV2Diagnostics()
	blockedDiagnostics.add("rows_blocked", "/rows")
	blockedResult := finishV2Result(AcceptanceResultV1{}, v2Facts(blocked), blockedDiagnostics, &blocked)
	if blockedResult.Status != "blocked" || blockedResult.Code != "rows_blocked" {
		t.Fatalf("blocked implementation finalization changed: %+v", blockedResult)
	}
	assertV2Rows(t, blockedResult, []string{"valid", "blocked"}, []string{"observed", "blocked"})

	unsupported := matrix
	unsupported.Rows[0].AcceptanceClass = "benchmark"
	unsupported.Rows[1].AcceptanceClass = "evidence"
	unsupportedDiagnostics := newV2Diagnostics()
	unsupportedDiagnostics.add("unsupported_class_policy", "/rows/0/acceptance_class")
	unsupportedResult := finishV2Result(AcceptanceResultV1{}, v2Facts(unsupported), unsupportedDiagnostics, &unsupported)
	if unsupportedResult.Status != "blocked" || unsupportedResult.Code != "unsupported_class_policy" {
		t.Fatalf("unsupported implementation finalization changed: %+v", unsupportedResult)
	}
	assertV2Rows(t, unsupportedResult, []string{"blocked", "blocked"}, []string{"unsupported_class_policy", "unsupported_class_policy"})
}

func TestAcceptanceV2PublicationPrecedenceAndArtifactClasses(t *testing.T) {
	request := publicationV2Request(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
	request.FactsSHA256 = strings.Repeat("0", 64)
	result := ValidateAcceptanceV2(request)
	if result.Code != "digest_mismatch" || result.Status != "invalid" || len(result.Rows) != 1 || result.Rows[0].Code != "digest_mismatch" {
		t.Fatalf("facts digest did not win publication precedence: %+v", result)
	}
	request.FactsSHA256 = normalizedFactsDigestV1(request.NormalizedFacts)

	matrixData, err := base64.StdEncoding.DecodeString(request.MatrixBase64)
	if err != nil {
		t.Fatal(err)
	}
	var matrix AcceptanceMatrixV2
	if err := json.Unmarshal(matrixData, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Rows[0].Specification == nil {
		t.Fatal("publication fixture lost specification evidence")
	}
	artifacts := matrix.Rows[0].Specification.Artifacts
	matrix.Rows[0].Specification.Artifacts = []AcceptanceArtifactV2{artifacts[0], artifacts[2]}
	result = ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
	if result.Code != "artifact_path_mismatch" || len(result.Rows) != 1 || result.Rows[0].Code != "artifact_path_mismatch" {
		t.Fatalf("missing publication artifact did not produce path mismatch: %+v", result)
	}

	matrix.Rows[0].Specification.Artifacts = artifacts
	matrix.Rows[0].Specification.Artifacts[0].SHA256 = strings.Repeat("0", 64)
	result = ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
	if result.Code != "artifact_path_mismatch" || len(result.Rows) != 1 || result.Rows[0].Code != "artifact_path_mismatch" || !hasV2Diagnostic(result, "artifact_digest_mismatch") {
		t.Fatalf("publication artifact digest failure changed code or diagnostics: %+v", result)
	}

	matrix.Rows[0].Specification.Artifacts = artifacts
	matrix.Rows[0].Specification.Artifacts[0].Path = "../outside"
	result = ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
	if result.Code != "artifact_path_mismatch" || len(result.Rows) != 1 || result.Rows[0].Code != "artifact_path_mismatch" || !hasV2Diagnostic(result, "evidence_path_invalid") {
		t.Fatalf("publication artifact path failure changed code or diagnostics: %+v", result)
	}
}

func TestAcceptanceV2AIDEV187FixtureIsExactAndModelNeutral(t *testing.T) {
	plan, err := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan) != 44524 || fileSHA256(plan) != "e88bafec7997fa247e56451dc72fd49007e9ac1128679d9ee21a6cc061848744" {
		t.Fatal("AIDEV-187 plan fixture is not the approved byte sequence")
	}
	if len(manifest) != 17392 || fileSHA256(manifest) != "f11f7b638adfec563482163f91d299df00467a3909bb27458cc9da8c6025dabc" {
		t.Fatal("AIDEV-187 manifest fixture is not the approved byte sequence")
	}
	var decoded AcceptanceManifest
	if err := json.Unmarshal(manifest, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SchemaVersion != AcceptanceManifestV2SchemaVersion || decoded.TicketID != "AIDEV-187" || decoded.Repository != "Zkrausman/pi-sampler" || decoded.PlanPath != "docs/techPlans/AIDEV-187-implementation-plan.md" || decoded.PlanSHA256 != fileSHA256(plan) || decoded.BaseSHA != "3d858a0d4f8219f5ca1db13ad1de72e35ee09758" {
		t.Fatalf("fixture binding changed: %+v", decoded)
	}
	want := []struct {
		id, title, class, requirement string
	}{
		{"AIDEV-187-1", "Admitted optional schema bridge", "authority", "The optional schema bridge is admitted by the original-base preflight and full profile tests while current profile, trusted loader, active review scripts, and v3 behavior remain byte-identical."},
		{"AIDEV-187-2", "Exact deterministic policy resolution", "authority", "Exact-base policy loading and resolution ignore untrusted selectors and follow the fixed catalog, profile-admission, considered-set, availability, precedence, and golden-envelope rules."},
		{"AIDEV-187-3", "Configured current assignments", "ordinary", "The adopted profile resolves manual Antigravity Gemini planner, Luna implementer, Sol primary reviewer, and Sol final reviewer with exact selected envelopes."},
		{"AIDEV-187-4", "Terra and same-model role validity", "authority", "Terra direct selection and same-model Sol role assignments resolve without override or model-inequality trust checks, while context admission remains unavailable."},
		{"AIDEV-187-5", "Golden override fallback diagnostics", "ordinary", "Allowlisted override, both zero-based fallback positions, malformed availability, unsupported catalogs, nonallowed override, exhaustion, and unspecified policy return exact golden envelopes."},
		{"AIDEV-187-6", "Portable canonical resolution", "resource-bounded", "Policy and resolution canonical bytes, null or zero-based fallbackIndex values, bounds, and domain-separated digest vectors are identical on Windows and Linux."},
		{"AIDEV-187-7", "Executable opaque context boundary", "authority", "The byte-preserving context consumer rejects self-attestation, keeps the dispatch unavailable, and freezes the exact bounded provider-v1 request, result, module, digest, timeout, and error interface for AIDEV-190."},
		{"AIDEV-187-8", "Exact packet v4 mapping", "authority", "Packet v4 exactly maps packet v3 including canonical root package-lock admission through 524288 bytes and ordinary 131072-byte endpoints, binds policy/context digests, rejects stale policy, and remains non-authoritative."},
		{"AIDEV-187-9", "Exact receipt and marker mappings", "authority", "Receipt v2 binds policy and context digests at root and every pass, and marker v4 follows the exact grammar and key order while preserving lifecycle, revocation, provenance, privacy, and inactive publication."},
		{"AIDEV-187-10", "Frozen legacy dispatch", "authority", "Immutable dispatch and package-lock boundary parity preserve packet v3, receipt v1, marker v3, terra-final-v1, and terra-parent bytes/results without invented fields, silent upgrade, reinterpretation, or downgrade."},
		{"AIDEV-187-11", "Exact slice ownership and neutral names", "ordinary", "Every model-neutral agent, skill, API, template, documentation, compatibility alias, test, and fixture path is correctly classified and assigned to exactly one slice."},
		{"AIDEV-187-12", "Old-base-valid non-vacuous delivery", "authority", "All slices use the exact external dependency lease, preceding-base admission, path allowlists, non-vacuous tests, independent review, protected CI, and restored no-residue status while publishing downstream digests without activating v4."},
	}
	if len(decoded.Rows) != len(want) {
		t.Fatalf("fixture row count changed: %d", len(decoded.Rows))
	}
	for index, expected := range want {
		got := decoded.Rows[index]
		if got.ID != expected.id || got.Title != expected.title || got.AcceptanceClass != expected.class || got.Requirement != expected.requirement {
			t.Fatalf("fixture tuple %d changed: got=%+v want id=%q title=%q class=%q requirement=%q", index, got, expected.id, expected.title, expected.class, expected.requirement)
		}
	}
	compatibility := ParseImplementationPlanManifestV2Compatibility(plan, manifest)
	if compatibility.Status != "valid" || compatibility.Code != "compatibility_tuple_understood" || compatibility.DeliveryAdmitted || compatibility.PlanSHA256 != fileSHA256(plan) || compatibility.ManifestSHA256 != fileSHA256(manifest) {
		t.Fatalf("fixture compatibility changed: %+v", compatibility)
	}
	if !strings.Contains(string(plan), "model-neutral role policy") || !strings.Contains(string(plan), "planner|implementer|primary-reviewer|final-reviewer") {
		t.Fatal("approved plan no longer documents model-neutral role semantics")
	}
}

func TestAcceptanceV2FrozenSlice1ABoundaryHashes(t *testing.T) {
	files := []struct {
		path, sha256 string
	}{
		{"../../docs/delivery-evidence/acceptance-matrix-v2.schema.json", "ae9844c1e0797d35c586619895d4bd39f20a4f296ce7d26b69a135b925a204a9"},
		{"acceptance_v2.go", "f3e719ebaa8e9a65e8d130bbb6aed185108c5511f5468f07d98d6717f717d2a9"},
		{"acceptance_v2_wire.go", "934f2c3dd906c643ba2c47f99a6e921093acd97e5d20c6db50433bff97126115"},
		{"external_root_posix.go", "d37b15f17a91a6b4725ae3e47074027f395ab8d2f725d59b3aa0f12191fb8062"},
		{"external_root_windows.go", "e9862010a7062cd313fff66f80a4be1e6537ce80a30dc6f641f8981a10281653"},
		{"../../cmd/delivery-evidence-validator/main.go", "3ad4da277648c55df9be27aefa2b4ef038dfae627193c563976fcead68157e03"},
		{"../../../scripts/validate-delivery-schemas.mjs", "bde6b56ed7adbd8d05fd7cef13ad0905cc02b66f8a0fdcdcdb3ffda74ef23496"},
		{"../../docs/delivery-evidence/acceptance-manifest-v1.schema.json", "03733cedbc78f42ffc9268d7da7071184b2bf2ab702a0d4211237b278526d53d"},
		{"../../docs/delivery-evidence/acceptance-matrix-v1.schema.json", "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021"},
		{"acceptance.go", "1ada2e07253b0b1c5053461cb9d2e4689b14948358b779b847842d50033fcfb6"},
		{"schema.go", "99a2acfc90622040995864b48f1194b919f2a679f7460df57d8a5aa8eddf83fd"},
		{"../../../scripts/final-review-receipt.mjs", "6f54daaf0ca4d9e9d77a7b6ae10ef501dfefdcd3f95f86b0cf436494f36b8f70"},
		{"../../../scripts/validate-adversarial-review-attestation.mjs", "3f82e8ac12170dff1dd97be463714000999fee1d23c01b4f436593b976771716"},
		{"../../../scripts/hooks/pre-push.mjs", "909cbd70be40b99cd08c2087e4ed47a9e9fcc9cbef7147e40c938f100748d992"},
		{"../../../.github/workflows/adversarial-review.yml", "f13e54e13a3fa6243fce15c71e1cd8b85ab186d58ce8e17eb365bb001847e9cc"},
		{"../../../.github/workflows/validate.yml", "35c3e2e44099b88a877185670e6a6df9b6da5b404fdb9290d404bd5fed0dbdef"},
		{"../../../.github/pull_request_template.md", "39487f1e424b45a10ecab24cacb6ad45af79e0bab2873623f17b36f8420240c1"},
		{"../../../scripts/generate-review-packet.mjs", "11ebb005703f69a4431e4a28fdc050409a442e340cc09902c82a348272bff2b2"},
		{"../../../scripts/review-policy.mjs", "12d32a4b589dc1d1b05089409cc65e4fffcd7867b5eee438b140688a01cc7b4f"},
	}
	for _, file := range files {
		data, err := os.ReadFile(file.path)
		if err != nil {
			t.Fatalf("read frozen file %s: %v", file.path, err)
		}
		if got := fileSHA256(data); got != file.sha256 {
			t.Fatalf("frozen file %s changed: got %s want %s", file.path, got, file.sha256)
		}
	}
}
func publicationV2RequestWithRows(t *testing.T, count int) (AcceptanceV2Request, string) {
	t.Helper()
	request, root := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
	matrix := decodeV2MatrixForTest(t, request)
	if count == 0 {
		matrix.Rows = []AcceptanceMatrixV2Row{}
	} else {
		matrix.Rows = matrix.Rows[:1]
		for index := 1; index < count; index++ {
			row := cloneV2RowForTest(t, matrix.Rows[0])
			row.ID = "AIDEV-191-" + strconv.Itoa(index+1)
			matrix.Rows = append(matrix.Rows, row)
		}
	}
	return requestWithExactV2Matrix(request, matrix), root
}

func publicationV2ArtifactCountRequest(t *testing.T, count int) (AcceptanceV2Request, string) {
	t.Helper()
	if count < 3 {
		t.Fatalf("publication artifact count %d is below the required validator/review/inventory set", count)
	}
	root := t.TempDir()
	validator := []byte(`{"ok":true,"exit_status":0}`)
	review := []byte("decision: approved")
	if err := os.WriteFile(filepath.Join(root, "plan-validator-report.json"), validator, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), review, 0600); err != nil {
		t.Fatal(err)
	}
	artifacts := []AcceptanceArtifactV2{
		{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))},
		{Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))},
	}
	for index := 0; index < count-3; index++ {
		name := "artifact-" + strconv.Itoa(index)
		data := []byte("artifact-" + strconv.Itoa(index))
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
		artifacts = append(artifacts, AcceptanceArtifactV2{Name: name, Path: name, SHA256: fileSHA256(data), Bytes: int64(len(data))})
	}
	inventory := writeV2Inventory(t, root)
	artifacts = append(artifacts, AcceptanceArtifactV2{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))})
	evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: artifacts}
	matrix := v2Matrix("plan-publication", "authority", &evidence, nil)
	return v2Request(matrix, root, AcceptancePolicyV2{}), root
}

func publicationV2LargeArtifactRequest(t *testing.T, size int64, materialize bool) (AcceptanceV2Request, string) {
	t.Helper()
	root := t.TempDir()
	validator := []byte(`{"ok":true,"exit_status":0}`)
	review := []byte("decision: approved")
	if err := os.WriteFile(filepath.Join(root, "plan-validator-report.json"), validator, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), review, 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "large.bin")
	data := []byte("small")
	declaredBytes := size
	if materialize {
		if size < 0 || size > int64(int(^uint(0)>>1)) {
			t.Fatalf("large test size is not representable: %d", size)
		}
		data = bytes.Repeat([]byte{'z'}, int(size))
		declaredBytes = int64(len(data))
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	inventory := writeV2Inventory(t, root)
	artifacts := []AcceptanceArtifactV2{
		{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))},
		{Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))},
		{Name: "large.bin", Path: "large.bin", SHA256: fileSHA256(data), Bytes: declaredBytes},
		{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))},
	}
	evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: artifacts}
	matrix := v2Matrix("plan-publication", "authority", &evidence, nil)
	return v2Request(matrix, root, AcceptancePolicyV2{}), root
}

func implementationV2AggregateLimitRequest(t *testing.T) AcceptanceV2Request {
	t.Helper()
	root := t.TempDir()
	const rows = 13
	total := int64(maxV2Total) + 1
	per := total / rows
	remainder := total - per*rows
	matrix := v2Matrix("implementation-delivery", "ordinary", nil, nil)
	matrix.Rows = make([]AcceptanceMatrixV2Row, 0, rows)
	policy := AcceptancePolicyV2{Classes: []AcceptanceClassPolicyV2{{ID: "ordinary", Kind: "ordinary", Verifier: "test-verifier", Environment: "local", Command: []string{"test"}, Version: "v1"}}}
	for index := 0; index < rows; index++ {
		size := per
		if index == rows-1 {
			size += remainder
		}
		now := v2Now()
		evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "test-verifier", Version: "v1", Environment: "local", Argv: []string{"test"}}, ExitStatus: 0, StartedAt: now, CompletedAt: now, Artifacts: []AcceptanceArtifactV2{{Name: "payload-" + strconv.Itoa(index), Path: "payload-" + strconv.Itoa(index) + ".bin", SHA256: strings.Repeat("0", 64), Bytes: size}}}
		matrix.Rows = append(matrix.Rows, AcceptanceMatrixV2Row{ID: "AIDEV-191-" + strconv.Itoa(index+1), AcceptanceClass: "ordinary", Requirement: "aggregate bound", Status: "observed", Evidence: &evidence})
	}
	matrix.GeneratedAt = v2Now()
	return v2Request(matrix, root, policy)
}

func publicSourceMutationResult(t *testing.T) AcceptanceResultV1 {
	t.Helper()
	request, root := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
	// Mutate an evidence source after its declared digest was captured. The
	// public validator, rather than a finalizer helper, must reject every row.
	mutated := []byte("decision: approved\nsource bytes changed")
	if err := os.WriteFile(filepath.Join(root, "independent-plan-review.md"), mutated, 0600); err != nil {
		t.Fatal(err)
	}
	return ValidateAcceptanceV2(request)
}

func TestAcceptanceV2PublicMultiRowFailureTable(t *testing.T) {
	cases := []struct {
		name        string
		run         func(*testing.T) AcceptanceResultV1
		status      string
		code        string
		rows        int
		diagnostics []expectedV2Diagnostic
	}{
		{"valid publication control", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			return ValidateAcceptanceV2(request)
		}, "valid", "specified", 2, nil},
		{"parser and schema", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			raw := decodeMatrixBytesForTest(t, request)
			mutated := bytes.Replace(raw, []byte(`"evaluation_scope":"plan-publication"`), []byte(`"evaluation_scope":"plan-publication","unknown":true`), 1)
			if bytes.Equal(raw, mutated) {
				t.Fatal("schema mutation did not change the matrix bytes")
			}
			request.MatrixBase64 = base64.StdEncoding.EncodeToString(mutated)
			return ValidateAcceptanceV2(request)
		}, "invalid", "matrix_schema_invalid", 0, []expectedV2Diagnostic{{"matrix_schema_invalid", "/matrix"}}},
		{"binding", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			matrix := decodeV2MatrixForTest(t, request)
			matrix.Repository = "Other/repository"
			return ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
		}, "invalid", "binding_mismatch", 2, []expectedV2Diagnostic{{"binding_mismatch", "/repository"}}},
		{"facts digest", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			request.FactsSHA256 = strings.Repeat("0", 64)
			return ValidateAcceptanceV2(request)
		}, "invalid", "digest_mismatch", 2, []expectedV2Diagnostic{{"digest_mismatch", "/facts_sha256"}}},
		{"artifact path and inventory path precedence", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			matrix := decodeV2MatrixForTest(t, request)
			matrix.Rows[0].Specification.Artifacts[0].Path = "../outside"
			return ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
		}, "invalid", "artifact_path_mismatch", 2, []expectedV2Diagnostic{{"artifact_path_mismatch", "/rows/0/specification/artifacts"}, {"evidence_path_invalid", "/rows/0/specification/artifacts/0/path"}}},
		{"inventory content", func(t *testing.T) AcceptanceResultV1 {
			request, root := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			forged := CanonicalExternalEvidenceInventoryReport(ExternalEvidenceInventory{Entries: []ExternalEvidenceInventoryEntry{}})
			if err := os.WriteFile(filepath.Join(root, "evidence-inventory.json"), forged, 0600); err != nil {
				t.Fatal(err)
			}
			matrix := decodeV2MatrixForTest(t, request)
			inventoryArtifact := &matrix.Rows[0].Specification.Artifacts[2]
			inventoryArtifact.SHA256 = fileSHA256(forged)
			inventoryArtifact.Bytes = int64(len(forged))
			return ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
		}, "invalid", "matrix_schema_invalid", 2, []expectedV2Diagnostic{{"matrix_schema_invalid", "/rows/0/specification/artifacts/2"}, {"artifact_digest_mismatch", "/rows/1/specification/artifacts/2/sha256"}}},
		{"artifact digest", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			matrix := decodeV2MatrixForTest(t, request)
			matrix.Rows[0].Specification.Artifacts[0].SHA256 = strings.Repeat("0", 64)
			return ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
		}, "invalid", "artifact_path_mismatch", 2, []expectedV2Diagnostic{{"artifact_path_mismatch", "/rows/0/specification/artifacts"}, {"artifact_digest_mismatch", "/rows/0/specification/artifacts/0/sha256"}}},
		{"source bytes changed", publicSourceMutationResult, "invalid", "matrix_schema_invalid", 2, []expectedV2Diagnostic{{"matrix_schema_invalid", "/rows/0/specification/artifacts/2"}, {"matrix_schema_invalid", "/rows/1/specification/artifacts/2"}, {"artifact_path_mismatch", "/rows/0/specification/artifacts"}, {"artifact_path_mismatch", "/rows/1/specification/artifacts"}, {"artifact_digest_mismatch", "/rows/0/specification/artifacts/1/sha256"}, {"artifact_digest_mismatch", "/rows/1/specification/artifacts/1/sha256"}}},
		{"digest wins over path", func(t *testing.T) AcceptanceResultV1 {
			request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
			request.FactsSHA256 = strings.Repeat("0", 64)
			matrix := decodeV2MatrixForTest(t, request)
			matrix.Rows[0].Specification.Artifacts[0].Path = "../outside"
			return ValidateAcceptanceV2(requestWithV2Matrix(request, matrix))
		}, "invalid", "digest_mismatch", 2, []expectedV2Diagnostic{{"digest_mismatch", "/facts_sha256"}, {"evidence_path_invalid", "/rows/0/specification/artifacts/0/path"}}},
		{"policy missing on public implementation path", func(t *testing.T) AcceptanceResultV1 {
			request, _ := implementationV2MultiRowRequest(t)
			request.Policy = []byte("null")
			return ValidateAcceptanceV2(request)
		}, "invalid", "policy_missing", 2, []expectedV2Diagnostic{{"policy_missing", "/rows/0/evidence/verifier"}, {"policy_missing", "/rows/1/evidence/verifier"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := tc.run(t)
			assertPublicResultRows(t, result, tc.status, tc.code, tc.rows)
			assertV2DiagnosticsExact(t, result, tc.diagnostics...)
		})
	}
}

func runA191T05ExactBounds(t *testing.T) {
	t.Helper()
	t.Run("zero rows", func(t *testing.T) {
		request, _ := publicationV2RequestWithRows(t, 0)
		result := ValidateAcceptanceV2(request)
		assertPublicResultRows(t, result, "invalid", "matrix_schema_invalid", 0)
	})
	t.Run("129 rows", func(t *testing.T) {
		request, _ := publicationV2RequestWithRows(t, maxV2Rows+1)
		result := ValidateAcceptanceV2(request)
		assertPublicResultRows(t, result, "invalid", "matrix_schema_invalid", maxV2Rows+1)
		assertV2DiagnosticCodes(t, result, "matrix_schema_invalid")
	})
	t.Run("matrix two MiB plus one", func(t *testing.T) {
		request, _ := publicationV2MultiRowRequest(t, []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved"))
		request.MatrixBase64 = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{' '}, maxAcceptanceMatrixV2Bytes+1))
		result := ValidateAcceptanceV2(request)
		assertPublicResultRows(t, result, "invalid", "artifact_too_large", 0)
		assertV2DiagnosticCodes(t, result, "artifact_too_large")
	})
	t.Run("32 artifacts accepted and 33 rejected", func(t *testing.T) {
		validRequest, _ := publicationV2ArtifactCountRequest(t, maxV2Artifacts)
		valid := ValidateAcceptanceV2(validRequest)
		assertPublicResultRows(t, valid, "valid", "specified", 1)
		tooManyRequest, _ := publicationV2ArtifactCountRequest(t, maxV2Artifacts+1)
		tooMany := ValidateAcceptanceV2(tooManyRequest)
		assertPublicResultRows(t, tooMany, "invalid", "matrix_schema_invalid", 1)
		assertV2DiagnosticCodes(t, tooMany, "matrix_schema_invalid")
	})
	t.Run("ten MiB file accepted and plus one rejected", func(t *testing.T) {
		validRequest, _ := publicationV2LargeArtifactRequest(t, maxAcceptanceV2ArtifactBytes, true)
		valid := ValidateAcceptanceV2(validRequest)
		assertPublicResultRows(t, valid, "valid", "specified", 1)
		tooLargeRequest, _ := publicationV2LargeArtifactRequest(t, maxAcceptanceV2ArtifactBytes+1, false)
		tooLarge := ValidateAcceptanceV2(tooLargeRequest)
		assertPublicResultRows(t, tooLarge, "invalid", "artifact_too_large", 1)
		assertV2DiagnosticCodes(t, tooLarge, "artifact_too_large")
	})
	t.Run("aggregate one hundred MiB plus one", func(t *testing.T) {
		result := ValidateAcceptanceV2(implementationV2AggregateLimitRequest(t))
		assertPublicResultRows(t, result, "invalid", "artifact_too_large", 13)
		assertV2DiagnosticCodes(t, result, "artifact_too_large")
	})
}

func decodeMatrixBytesForTest(t *testing.T, request AcceptanceV2Request) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(request.MatrixBase64)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func runLegacyManifestCLI(t *testing.T, repositoryRoot, manifestPath, base string) (int, string, string) {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate validator test source for legacy CLI")
	}
	governanceRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "go", "run", "./cmd/delivery-evidence-validator", "-mode", "manifest", "-acceptance-manifest", manifestPath, "-repo-root", repositoryRoot, "-expected-repository", "Zkrausman/pi-sampler", "-expected-base", base)
	command.Dir = governanceRoot
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	if ctx.Err() != nil {
		t.Fatalf("legacy CLI timed out: %v", ctx.Err())
	}
	if err == nil {
		return 0, stdout.String(), stderr.String()
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("legacy CLI did not return an exit status: %v", err)
	}
	return exitErr.ExitCode(), stdout.String(), stderr.String()
}

func externalErrorCodeForTest(err error) string {
	var externalErr *ExternalEvidenceError
	if errors.As(err, &externalErr) {
		return externalErr.Code
	}
	return ""
}

func assertExternalErrorCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("evidence operation accepted an adversarial input; want %s", want)
	}
	if got := externalErrorCodeForTest(err); got != want {
		t.Fatalf("evidence operation returned %q; want %q (err=%v)", got, want, err)
	}
}

func assertExternalErrorCodeOneOf(t *testing.T, err error, wants ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("evidence operation accepted an adversarial input; want one of %v", wants)
	}
	got := externalErrorCodeForTest(err)
	for _, want := range wants {
		if got == want {
			return
		}
	}
	t.Fatalf("evidence operation returned %q; want one of %v (err=%v)", got, wants, err)
}

func writeExternalTestArtifact(t *testing.T, root, name string, data []byte) AcceptanceArtifactV2 {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return AcceptanceArtifactV2{Name: name, Path: name, SHA256: fileSHA256(data), Bytes: int64(len(data))}
}

func requireFilesystemMutation(t *testing.T, operation string, err error) {
	t.Helper()
	if err != nil {
		t.Skipf("blocked/filesystem_capability_unavailable: %s: %v", operation, err)
	}
}

func runPlatformExternalEvidenceAdversaries(t *testing.T) {
	t.Helper()
	runExternalIdentityReplacementAdversaries(t)
	if runtime.GOOS == "windows" {
		runWindowsExternalEvidenceAdversaries(t)
		return
	}
	runPOSIXExternalEvidenceAdversaries(t)
}

func runExternalIdentityReplacementAdversaries(t *testing.T) {
	t.Helper()
	t.Run("portable traversal is rejected", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		artifact.Path = "../outside"
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, artifact)
			return err
		}(), "evidence_path_invalid")
	})
	t.Run("root replacement is identity rejected", func(t *testing.T) {
		parent := t.TempDir()
		root := filepath.Join(parent, "root")
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		oldRoot := filepath.Join(parent, "root-replaced")
		requireFilesystemMutation(t, "replace evidence root", os.Rename(root, oldRoot))
		if err := os.Mkdir(root, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), []byte("attacker"), 0600); err != nil {
			t.Fatal(err)
		}
		_, err = ReadVerifiedArtifact(opened, artifact)
		assertExternalErrorCode(t, err, "evidence_identity_changed")
	})
	t.Run("ancestor replacement is identity rejected", func(t *testing.T) {
		parent := t.TempDir()
		container := filepath.Join(parent, "container")
		root := filepath.Join(container, "root")
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		oldContainer := filepath.Join(parent, "container-replaced")
		requireFilesystemMutation(t, "replace evidence ancestor", os.Rename(container, oldContainer))
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), []byte("attacker"), 0600); err != nil {
			t.Fatal(err)
		}
		_, err = ReadVerifiedArtifact(opened, artifact)
		assertExternalErrorCode(t, err, "evidence_identity_changed")
	})
	t.Run("artifact replacement is digest rejected", func(t *testing.T) {
		root := t.TempDir()
		trusted := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", trusted)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		replaced := filepath.Join(root, "proof-replaced.txt")
		requireFilesystemMutation(t, "replace evidence artifact", os.Rename(filepath.Join(root, "proof.txt"), replaced))
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), []byte("attacker"), 0600); err != nil {
			t.Fatal(err)
		}
		_, err = ReadVerifiedArtifact(opened, artifact)
		assertExternalErrorCode(t, err, "artifact_digest_mismatch")
	})
	t.Run("source bytes changed are digest rejected", func(t *testing.T) {
		root := t.TempDir()
		trusted := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", trusted)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "proof.txt"), []byte("attacker"), 0600); err != nil {
			t.Fatal(err)
		}
		_, err = ReadVerifiedArtifact(opened, artifact)
		assertExternalErrorCode(t, err, "artifact_digest_mismatch")
	})
}

func runPOSIXExternalEvidenceAdversaries(t *testing.T) {
	t.Helper()
	t.Run("real hard link and symlink rejection", func(t *testing.T) {
		root := t.TempDir()
		data := []byte("trusted")
		artifact := writeExternalTestArtifact(t, root, "proof.txt", data)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		hardLink := filepath.Join(root, "hard-link.txt")
		if err := os.Link(filepath.Join(root, "proof.txt"), hardLink); err != nil {
			t.Fatalf("required POSIX hard-link capability unavailable: %v", err)
		}
		if source, linked := fileInfoForTest(t, filepath.Join(root, "proof.txt")), fileInfoForTest(t, hardLink); !os.SameFile(source, linked) {
			t.Fatal("hard-link fixture is not the same filesystem object")
		}
		hard := artifact
		hard.Path = "hard-link.txt"
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, hard)
			return err
		}(), "evidence_path_invalid")
		symlink := filepath.Join(root, "symbolic-link.txt")
		if err := os.Symlink("proof.txt", symlink); err != nil {
			t.Fatalf("required POSIX symlink capability unavailable: %v", err)
		}
		linked := artifact
		linked.Path = "symbolic-link.txt"
		assertExternalErrorCode(t, func() error {
			_, err := ReadVerifiedArtifact(opened, linked)
			return err
		}(), "evidence_path_invalid")
	})
	t.Run("real POSIX source mutation race never accepts attack bytes", func(t *testing.T) {
		root := t.TempDir()
		trusted := bytes.Repeat([]byte{'T'}, 256*1024)
		attack := bytes.Repeat([]byte{'A'}, len(trusted))
		artifact := writeExternalTestArtifact(t, root, "proof.txt", trusted)
		opened, err := OpenExternalEvidenceRoot(root)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(root, "proof.txt")
		stop := make(chan struct{})
		var stopOnce sync.Once
		var wg sync.WaitGroup
		stopWorkers := func() {
			stopOnce.Do(func() { close(stop) })
			wg.Wait()
		}
		defer stopWorkers()
		started := make(chan struct{})
		var startOnce sync.Once
		errCh := make(chan error, 1)
		recordError := func(err error) {
			select {
			case errCh <- err:
			default:
			}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := 0; index < 64; index++ {
				select {
				case <-stop:
					return
				default:
				}
				if err := os.WriteFile(path, attack, 0600); err != nil {
					recordError(err)
					return
				}
				startOnce.Do(func() { close(started) })
				if err := os.WriteFile(path, trusted, 0600); err != nil {
					recordError(err)
					return
				}
			}
		}()
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			stopWorkers()
			t.Fatal("POSIX mutation writer did not perform an attack write")
		}
		for index := 0; index < 64; index++ {
			got, readErr := ReadVerifiedArtifact(opened, artifact)
			if readErr == nil {
				if !bytes.Equal(got, trusted) {
					stopWorkers()
					t.Fatal("attack bytes were accepted as verified evidence")
				}
				continue
			}
			assertExternalErrorCodeOneOf(t, readErr, "evidence_identity_changed", "artifact_digest_mismatch", "source_mutated", "evidence_path_invalid", "evidence_root_invalid")
		}
		stopWorkers()
		select {
		case writeErr := <-errCh:
			t.Fatalf("POSIX mutation writer failed: %v", writeErr)
		default:
		}
	})
	t.Run("public inventory mutation reports source_mutated", func(t *testing.T) {
		observed := false
		for attempt := 0; attempt < 12 && !observed; attempt++ {
			request, root := publicationV2LargeArtifactRequest(t, maxAcceptanceV2ArtifactBytes, true)
			start := make(chan struct{})
			errCh := make(chan error, 1)
			var wg sync.WaitGroup
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				time.Sleep(time.Duration(attempt+1) * time.Millisecond)
				if err := os.WriteFile(filepath.Join(root, "inventory-race.txt"), []byte("appeared during validation"), 0600); err != nil {
					errCh <- err
				}
			}()
			close(start)
			result := ValidateAcceptanceV2(request)
			wg.Wait()
			select {
			case writeErr := <-errCh:
				t.Fatalf("POSIX inventory mutation writer failed: %v", writeErr)
			default:
			}
			if hasV2Diagnostic(result, "source_mutated") {
				assertPublicResultRows(t, result, "invalid", "source_mutated", 1)
				assertV2DiagnosticCodes(t, result, "source_mutated")
				observed = true
			}
		}
		if !observed {
			t.Fatalf("capable POSIX public validation never observed source_mutated")
		}
	})
}

func fileInfoForTest(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func runWindowsTestCommand(t *testing.T, executable string, args ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		return string(output), ctx.Err()
	}
	return string(output), err
}

func requireWindowsCommandCapability(t *testing.T, operation, output string, err error) {
	t.Helper()
	if err != nil {
		t.Skipf("blocked/windows_capability_unavailable: %s: status=%v output=%q", operation, err, output)
	}
	if strings.ContainsRune(output, 0) {
		t.Fatalf("Windows capability command returned NUL output for %s", operation)
	}
}
