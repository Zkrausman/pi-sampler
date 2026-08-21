package deliveryevidence

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
