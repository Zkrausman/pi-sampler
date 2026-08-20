package wikigovernance

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func TestLoadPolicyAcceptsValidInputAndRejectsUnknownField(t *testing.T) {
	root := t.TempDir()
	policyPath := filepath.Join(root, "docs", "wiki-governance", "path-policy-v1.json")
	if err := os.MkdirAll(filepath.Dir(policyPath), 0755); err != nil {
		t.Fatal(err)
	}
	valid := `{
		"schema_version": "wiki-governance-path-policy/v1",
		"canonical_versioned": ["canonical/**"],
		"generated_local": ["generated/**"],
		"external_immutable_evidence": ["raw/**"],
		"sensitive_never_commit": ["sensitive/**"]
	}`
	if err := os.WriteFile(policyPath, []byte(valid), 0644); err != nil {
		t.Fatal(err)
	}
	policy, err := LoadPolicy(root)
	if err != nil {
		t.Fatalf("valid policy rejected: %v", err)
	}
	if got := policy.Classify("canonical/page.md"); got != Canonical {
		t.Fatalf("valid policy did not classify canonical path: %q", got)
	}

	invalid := strings.Replace(valid, "\n\t}", `,
		"unreviewed_default": true
	}`, 1)
	if err := os.WriteFile(policyPath, []byte(invalid), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPolicy(root); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("policy with an unknown field was accepted: %v", err)
	}
}

func TestPolicyClassifiesCollaborationBoundary(t *testing.T) {
	policy, err := LoadPolicy(repositoryRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]Classification{
		".llm-wiki/wiki/index.md":                           Canonical,
		".llm-wiki/wiki/concepts/delivery-evidence.md":      Canonical,
		".llm-wiki/templates/pages/concept.md":              Canonical,
		".pi/policy.json":                                   Canonical,
		"evidence/references/WORK-121.json":                 Canonical,
		".llm-wiki/meta/registry.json":                      GeneratedLocal,
		".llm-wiki/config.json":                             Canonical,
		".llm-wiki/raw/sources/SRC-2026-08-06-001/original": ExternalEvidence,
		"evidence/raw/SRC-2026-08-06-001/original":          ExternalEvidence,
		".pi/oauth/state.json":                              SensitiveLocal,
		".pi/sessions/current.json":                         SensitiveLocal,
		"artifacts/tool-output/unredacted.log":              SensitiveLocal,
		".llm-wiki/unclassified.bin":                        SensitiveLocal,
		"src/domain-risk/risk.go":                           OutsideScope,
	}
	for path, want := range cases {
		if got := policy.Classify(path); got != want {
			t.Errorf("Classify(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestValidateCandidatePathsRejectsSecretAndRawArtifacts(t *testing.T) {
	root := t.TempDir()
	policy := Policy{
		Canonical: []string{"canonical/*.md"},
		Generated: []string{"generated/**"},
		External:  []string{"raw/**"},
		Sensitive: []string{"sensitive/**"},
	}
	canonical := filepath.Join(root, "canonical", "page.md")
	if err := os.MkdirAll(filepath.Dir(canonical), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(canonical, []byte("api_key = very-secret-value"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := policy.ValidateCandidatePaths(root, []string{"canonical/page.md"}); err == nil || !strings.Contains(err.Error(), "credential-like") {
		t.Fatalf("secret canonical artifact accepted: %v", err)
	}
	if err := policy.ValidateCandidatePaths(root, []string{"raw/SRC-2026-08-06-001/original"}); err == nil || !strings.Contains(err.Error(), string(ExternalEvidence)) {
		t.Fatalf("raw evidence artifact accepted: %v", err)
	}
	if err := policy.ValidateCandidatePaths(root, []string{"sensitive/session.json"}); err == nil || !strings.Contains(err.Error(), string(SensitiveLocal)) {
		t.Fatalf("sensitive artifact accepted: %v", err)
	}
}

func TestCanonicalArtifactRejectsSymlinkTargetsAndParents(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	policy := Policy{Canonical: []string{"canonical/*.md", "canonical/**/*.md"}, Generated: []string{"generated/**"}, External: []string{"raw/**"}, Sensitive: []string{"sensitive/**"}}
	localSecret := filepath.Join(root, "secret.env")
	outsideSecret := filepath.Join(outside, "outside.env")
	for _, path := range []string{localSecret, outsideSecret} {
		if err := os.WriteFile(path, []byte("must-not-be-read"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	canonicalDir := filepath.Join(root, "canonical")
	if err := os.MkdirAll(canonicalDir, 0755); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"local.md": localSecret, "external.md": outsideSecret} {
		link := filepath.Join(canonicalDir, name)
		if err := os.Symlink(target, link); err != nil {
			t.Skipf("symlink creation unavailable: %v", err)
		}
		if err := policy.ValidateCandidatePaths(root, []string{"canonical/" + name}); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("canonical symlink %s was accepted: %v", name, err)
		}
	}
	secretDirectory := filepath.Join(root, "secret-directory")
	if err := os.MkdirAll(secretDirectory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secretDirectory, "page.md"), []byte("must-not-be-read"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secretDirectory, filepath.Join(canonicalDir, "parent")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if err := policy.ValidateCandidatePaths(root, []string{"canonical/parent/page.md"}); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("canonical symlinked parent was accepted: %v", err)
	}
}

func TestRebuildMetadataRejectsCanonicalSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	policy := Policy{Canonical: []string{".llm-wiki/wiki/*.md", ".llm-wiki/wiki/**/*.md"}, Generated: []string{".llm-wiki/meta/**"}, External: []string{".llm-wiki/raw/**"}, Sensitive: []string{".pi/**"}}
	target := filepath.Join(outside, "outside.md")
	if err := os.WriteFile(target, []byte("must-not-be-read"), 0600); err != nil {
		t.Fatal(err)
	}
	wikiRoot := filepath.Join(root, ".llm-wiki", "wiki")
	if err := os.MkdirAll(wikiRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(wikiRoot, "linked.md")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if _, err := policy.RebuildMetadata(root); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("metadata rebuild accepted canonical symlink: %v", err)
	}
}

func TestEvidenceReferenceRejectsRawPayloadAndMalformedDigest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reference.json")
	valid := `{"schema_version":"evidence-reference/v1","source_id":"SRC-2026-08-06-001","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content_classification":"raw_external","redaction_status":"not_applicable"}`
	if err := os.WriteFile(path, []byte(valid), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEvidenceReferenceFile(path); err != nil {
		t.Fatal(err)
	}
	withRawPayload := strings.TrimSuffix(valid, "}") + `,"payload":"must-not-be-committed"}`
	if err := os.WriteFile(path, []byte(withRawPayload), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEvidenceReferenceFile(path); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("reference raw payload was accepted: %v", err)
	}
	if err := os.WriteFile(path, []byte(valid+`{"payload":"must-not-be-committed"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEvidenceReferenceFile(path); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("trailing evidence payload was accepted: %v", err)
	}
	badDigest := strings.Replace(valid, `"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`, `"sha256":"bad"`, 1)
	if err := os.WriteFile(path, []byte(badDigest), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateEvidenceReferenceFile(path); err == nil || !strings.Contains(err.Error(), "invalid sha256") {
		t.Fatalf("malformed digest was accepted: %v", err)
	}
}

func TestRebuildMetadataIsDeterministicAndCanonicalOnly(t *testing.T) {
	root := t.TempDir()
	policy := Policy{Canonical: []string{".llm-wiki/wiki/*.md", ".llm-wiki/wiki/**/*.md"}, Generated: []string{".llm-wiki/meta/**"}, External: []string{".llm-wiki/raw/**"}, Sensitive: []string{".pi/**"}}
	page := filepath.Join(root, ".llm-wiki", "wiki", "concepts", "index.md")
	if err := os.MkdirAll(filepath.Dir(page), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(page, []byte("# Canonical\n"), 0644); err != nil {
		t.Fatal(err)
	}
	first, err := policy.RebuildMetadata(root)
	if err != nil {
		t.Fatal(err)
	}
	firstBytes, err := os.ReadFile(filepath.Join(root, ".llm-wiki", "meta", "registry.json"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := policy.RebuildMetadata(root)
	if err != nil {
		t.Fatal(err)
	}
	secondBytes, err := os.ReadFile(filepath.Join(root, ".llm-wiki", "meta", "registry.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Pages) != 1 || len(second.Pages) != 1 || string(firstBytes) != string(secondBytes) {
		t.Fatalf("metadata rebuild is not deterministic: %#v %#v", first, second)
	}
}

func TestInventoryIsAggregateOnly(t *testing.T) {
	root := t.TempDir()
	policy := Policy{Canonical: []string{".llm-wiki/wiki/**/*.md"}, Generated: []string{".llm-wiki/meta/**"}, External: []string{".llm-wiki/raw/**"}, Sensitive: []string{".pi/**"}}
	files := map[string]string{
		".llm-wiki/wiki/concepts/index.md":                  "safe",
		".llm-wiki/meta/registry.json":                      "generated",
		".llm-wiki/raw/sources/SRC-2026-08-06-001/original": "do-not-disclose",
		".pi/credentials/token":                             "do-not-disclose",
	}
	for path, contents := range files {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	inventory, err := policy.InventoryRepository(root)
	if err != nil {
		t.Fatal(err)
	}
	report := FormatInventory(inventory)
	if inventory.Counts[string(Canonical)] != 1 || inventory.Counts[string(GeneratedLocal)] != 1 || inventory.Counts[string(ExternalEvidence)] != 1 || inventory.Counts[string(SensitiveLocal)] != 1 {
		t.Fatalf("unexpected inventory counts: %#v", inventory.Counts)
	}
	for _, forbidden := range []string{"do-not-disclose", "original", "credentials/token"} {
		if strings.Contains(report, forbidden) {
			t.Fatalf("aggregate report disclosed %q", forbidden)
		}
	}
}
