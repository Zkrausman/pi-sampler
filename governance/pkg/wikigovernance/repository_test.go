package wikigovernance

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRepositoryEnforcesGitIgnoreBoundary(t *testing.T) {
	policy, err := LoadPolicy(repositoryRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := policy.ValidateRepository(repositoryRoot(t)); err != nil {
		t.Fatal(err)
	}
}

func TestCleanCloneRebuildsCanonicalMetadataWithoutRawEvidence(t *testing.T) {
	original := repositoryRoot(t)
	source := filepath.Join(t.TempDir(), "source")
	clone := filepath.Join(t.TempDir(), "clone")
	for _, path := range []string{
		".gitignore",
		"docs/wiki-governance/path-policy-v1.json",
		".llm-wiki/README.md",
		".llm-wiki/WIKI_SCHEMA.md",
		".llm-wiki/templates/pages/concept.md",
		".llm-wiki/wiki/index.md",
		".pi/README.md",
		".pi/policy.json",
	} {
		copyFile(t, filepath.Join(original, filepath.FromSlash(path)), filepath.Join(source, filepath.FromSlash(path)))
	}
	raw := filepath.Join(source, ".llm-wiki", "raw", "sources", "SRC-2026-08-06-001", "original")
	if err := os.MkdirAll(filepath.Dir(raw), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(raw, []byte("must-not-be-committed"), 0600); err != nil {
		t.Fatal(err)
	}
	runGit(t, source, "init")
	runGit(t, source, "config", "user.email", "test@example.invalid")
	runGit(t, source, "config", "user.name", "Wiki Governance Test")
	runGit(t, source, "add", ".")
	runGit(t, source, "commit", "-m", "fixture")
	runCommand(t, "git", "clone", source, clone)

	if _, err := os.Stat(filepath.Join(clone, ".llm-wiki", "raw")); !os.IsNotExist(err) {
		t.Fatalf("clean clone includes raw evidence: %v", err)
	}
	policy, err := LoadPolicy(clone)
	if err != nil {
		t.Fatal(err)
	}
	if err := policy.ValidateRepository(clone); err != nil {
		t.Fatal(err)
	}
	index, err := policy.RebuildMetadata(clone)
	if err != nil {
		t.Fatal(err)
	}
	if len(index.Pages) != 1 || index.Pages[0].Path != ".llm-wiki/wiki/index.md" {
		t.Fatalf("unexpected rebuilt canonical index: %#v", index)
	}
	if _, err := os.Stat(filepath.Join(clone, ".llm-wiki", "meta", "registry.json")); err != nil {
		t.Fatalf("rebuild did not create local metadata: %v", err)
	}
}

func copyFile(t *testing.T, source, destination string) {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, data, 0644); err != nil {
		t.Fatal(err)
	}
}

func runGit(t *testing.T, directory string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}

func runCommand(t *testing.T, name string, args ...string) {
	t.Helper()
	command := exec.Command(name, args...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
	}
}
