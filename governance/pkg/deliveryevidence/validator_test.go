package deliveryevidence

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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
		if result.Code != "binding_mismatch" {
			t.Fatalf("unexpected result: %+v", result)
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
		policy := AcceptancePolicyV2{
			Classes: []AcceptanceClassPolicyV2{
				{ID: "benchmark-ci-regression", Kind: "benchmark", Verifier: "benchmark", Environment: "ci", Command: []string{"benchmark"}},
				{ID: "benchmark-local-10m", Kind: "benchmark", Verifier: "benchmark", Environment: "local", Command: []string{"benchmark"}},
			},
		}
		result := ValidateAcceptanceV2(v2Request(matrix, root, policy))
		if result.Status != "blocked" || result.Code != "unsupported_class_policy" {
			t.Fatalf("unexpected result: %+v", result)
		}
	})
	t.Run("A191-T09", func(t *testing.T) {
		if _, err := os.Stat("../../../contracts/delivery-acceptance-v2-activation.json"); !os.IsNotExist(err) {
			t.Fatalf("activation declaration unexpectedly present: %v", err)
		}
		if _, err := os.Stat("../../../contracts/delivery-acceptance-v2-trusted-map.json"); !os.IsNotExist(err) {
			t.Fatalf("trusted map unexpectedly present: %v", err)
		}
	})
	t.Run("A191-T10", func(t *testing.T) {
		plan, _ := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-implementation-plan.md")
		manifest, _ := os.ReadFile("../../../tests/fixtures/delivery-acceptance-v2/aidev-187-acceptance-manifest-v2.json")
		result := ParseImplementationPlanManifestV2Compatibility(plan, manifest)
		if len(result.Rows) != 12 || result.Rows[0].ID != "AIDEV-187-1" {
			t.Fatalf("unexpected tuple: %+v", result)
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
	})
	t.Run("A191-T12", func(t *testing.T) {
		data, err := os.ReadFile("../../docs/delivery-evidence/acceptance-matrix-v1.schema.json")
		if err != nil {
			t.Fatal(err)
		}
		if fileSHA256(data) != "c52283e1d360491ff67f90d1801f2f5ee7b98f4df9ff6e4c8c9f8dd3d94c0021" {
			t.Fatal("frozen v1 schema changed")
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
	evidence := AcceptanceEvidenceV2{Verifier: AcceptanceVerifierV2{ID: "parent", Version: "v1", Environment: "review", Argv: []string{"plan"}}, ExitStatus: 0, StartedAt: v2Now(), CompletedAt: v2Now(), Artifacts: []AcceptanceArtifactV2{
		{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))},
		{Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))},
		{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))},
	}}
	return v2Request(v2Matrix("plan-publication", "authority", &evidence, nil), root, AcceptancePolicyV2{})
}

func TestAcceptanceV2PublicationEvidenceIsAnchoredAndStrict(t *testing.T) {
	cases := []struct {
		name      string
		validator []byte
		review    []byte
	}{
		{"validator exit alias", []byte(`{"ok":true,"exit":0}`), []byte("decision: approved")},
		{"validator extra", []byte(`{"ok":true,"exit_status":0,"extra":1}`), []byte("decision: approved")},
		{"validator duplicate", []byte(`{"ok":true,"exit_status":0,"exit_status":0}`), []byte("decision: approved")},
		{"unapproved", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: unapproved")},
		{"disapproved", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: disapproved")},
		{"historical", []byte(`{"ok":true,"exit_status":0}`), []byte("historical decision: approved")},
		{"duplicate decision", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved\ndecision: approved")},
		{"conditional", []byte(`{"ok":true,"exit_status":0}`), []byte("decision: approved\nconditional approval is pending")},
	}
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
	for _, malformed := range [][]byte{
		[]byte("not an inventory"),
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[],"extra":true}`),
		[]byte(`{"version":1,"format":"pi-sampler.external-evidence-inventory/v1","entries":[]}
`),
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[],"entries":[]}
`),
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
		[]byte(`{"format":"pi-sampler.external-evidence-inventory/v1","version":1,"entries":[{"path":"proof.txt","type":"file","bytes":6,"identity":"forged","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}
`),
	} {
		if err := os.WriteFile(filepath.Join(root, acceptanceV2InventoryReportName), malformed, 0600); err != nil {
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
		{Name: "plan-validator-report.json", Path: "plan-validator-report.json", SHA256: fileSHA256(validator), Bytes: int64(len(validator))},
		{Name: "independent-plan-review.md", Path: "independent-plan-review.md", SHA256: fileSHA256(review), Bytes: int64(len(review))},
		{Name: "evidence-inventory.json", Path: "evidence-inventory.json", SHA256: fileSHA256(inventory), Bytes: int64(len(inventory))},
	}}
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
			if actual := validV2ArtifactName(string(raw)); actual != entry.Valid {
				t.Errorf("invalid UTF-8 artifact name: runtime=%v corpus=%v", actual, entry.Valid)
			}
			continue
		}
		if len(entry.Values) > 0 {
			actual := true
			seen := map[string]bool{}
			for _, value := range entry.Values {
				key := externalIdentityKey(value)
				if !validV2ArtifactName(value) || seen[key] {
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
		if actual := validV2ArtifactName(value); actual != entry.Valid {
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
	if runtime.GOOS != "windows" {
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
}

func TestAcceptanceV2WindowsFullVolumeIdentityModel(t *testing.T) {
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

func TestAcceptanceV2AncestorChurnDoesNotCauseFalseIdentityFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX ancestor churn route")
	}
	root := t.TempDir()
	data := []byte("proof")
	path := filepath.Join(root, "proof.txt")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	opened, err := OpenExternalEvidenceRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	artifact := AcceptanceArtifactV2{Name: "proof.txt", Path: "proof.txt", SHA256: fileSHA256(data), Bytes: int64(len(data))}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for index := 0; ; index++ {
			select {
			case <-stop:
				return
			default:
			}
			sibling := filepath.Join(filepath.Dir(root), "sibling-"+strconv.Itoa(index%4))
			_ = os.WriteFile(sibling, []byte("s"), 0600)
			_ = os.Remove(sibling)
		}
	}()
	for index := 0; index < 100; index++ {
		if _, err := ReadVerifiedArtifact(opened, artifact); err != nil {
			close(stop)
			wg.Wait()
			t.Fatalf("unrelated sibling churn failed: %v", err)
		}
	}
	close(stop)
	wg.Wait()
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
