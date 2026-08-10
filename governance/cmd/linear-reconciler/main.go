// linear-reconciler is the runtime adapter for WORK-107. It runs only in CI
// (triggered on pull_request closed / workflow_run completed for the master
// branch) and performs the verified Linear Done transition. It is fail-closed,
// idempotent, and never logs credentials or raw payload. All inputs besides
// GitHub/Linear tokens are repository-relative committed evidence.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zkrausman/pi-sampler/governance/pkg/deliveryevidence"
	"github.com/zkrausman/pi-sampler/governance/pkg/linearreconciler"
	"github.com/zkrausman/pi-sampler/governance/pkg/wikigovernance"
)

func main() {
	repoRoot := flag.String("repo-root", ".", "repository root")
	prNumber := flag.Int("pr-number", 0, "GitHub PR number (required)")
	githubRepo := flag.String("github-repo", os.Getenv("GITHUB_REPOSITORY"), "owner/repo (default $GITHUB_REPOSITORY)")
	githubToken := flag.String("github-token", "", "GitHub token (default $GITHUB_TOKEN)")
	linearKey := flag.String("linear-key", "", "Linear API key (default $LINEAR_API_KEY)")
	manifestPath := flag.String("manifest", "", "repository-relative manifest path (auto-derived from ticket when empty)")
	outputPath := flag.String("out", "", "optional JSON file for auditable transition event")
	dryRun := flag.Bool("dry-run", false, "do not mutate Linear; print decision only")
	flag.Parse()

	if *prNumber <= 0 {
		fatalf(" -pr-number is required")
	}
	resolvedRepo := mustAbs(*repoRoot)
	ghToken := *githubToken
	if ghToken == "" {
		ghToken = os.Getenv("GITHUB_TOKEN")
	}
	linKey := *linearKey
	if linKey == "" {
		linKey = os.Getenv("LINEAR_API_KEY")
	}
	// Do not log token presence or length.
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	gh := &linearreconciler.HTTPGitHubClient{
		Token:   ghToken,
		APIBase: os.Getenv("GITHUB_API_URL"),
	}
	owner, repo := splitRepo(*githubRepo)
	if owner == "" || repo == "" {
		fatalf(" -github-repo must be owner/repo")
	}

	pr, err := gh.GetPR(ctx, owner, repo, *prNumber)
	if err != nil {
		emitDecisionAndExit(nil, err, "fetch_pr_failed", *outputPath, 2)
	}
	// Only merged PRs are eligible.
	ticket := linearreconciler.ExtractTicket(pr.Title, pr.Body)
	if ticket == "" {
		// Try manifest ticket as fallback linkage (resolver may have it without PR text).
		// Keep ticket empty for now; reconciler will enforce manifest linkage.
	}

	// Resolve manifest path: explicit flag, else derived from ticket, else fail closed without churn.
	resolvedManifest := strings.TrimSpace(*manifestPath)
	if resolvedManifest == "" && ticket != "" {
		resolvedManifest = filepath.ToSlash(filepath.Join("evidence", "delivery", ticket+".json"))
	}
	if resolvedManifest == "" {
		d := decisionShell(*prNumber, pr.MergeCommitSHA, ticket, resolvedManifest, pr.Merged, pr.Draft)
		d.Reason = "cannot derive manifest path without ticket linkage"
		d.ReasonCode = linearreconciler.CodeNotLinked
		emitDecision(d, *outputPath, 0)
		return
	}
	manifestAbs := filepath.Join(resolvedRepo, filepath.FromSlash(resolvedManifest))
	// Compute manifest SHA for audit (safe digest, not raw payload).
	var manifestSHA string
	var manifestErr error
	var manifestTicket string
	var manifestCommit string
	manifestBytes, readErr := os.ReadFile(manifestAbs)
	if readErr != nil {
		manifestErr = readErr
	} else {
		sum := sha256.Sum256(manifestBytes)
		manifestSHA = hex.EncodeToString(sum[:])
		var raw struct {
			TicketID  string `json:"ticket_id"`
			CommitSHA string `json:"commit_sha"`
		}
		if err := json.Unmarshal(manifestBytes, &raw); err != nil {
			manifestErr = err
		} else {
			manifestTicket = raw.TicketID
			manifestCommit = strings.ToLower(strings.TrimSpace(raw.CommitSHA))
		}
		// Deterministic validation via real validator when commit is known.
		if manifestErr == nil && manifestCommit != "" {
			if err := deliveryevidence.ValidateFileAtCommit(manifestAbs, resolvedRepo, manifestCommit); err != nil {
				manifestErr = err
			}
		}
	}
	if ticket == "" && manifestTicket != "" {
		ticket = manifestTicket
	}
	if ticket == "" {
		d := decisionShell(*prNumber, pr.MergeCommitSHA, "", resolvedManifest, pr.Merged, pr.Draft)
		d.Reason = "linked ticket unavailable from PR and manifest"
		d.ReasonCode = linearreconciler.CodeNotLinked
		d.ManifestSHA256 = manifestSHA
		emitDecision(d, *outputPath, 0)
		return
	}

	// Required checks for the merge commit (or head when not merged yet — but we already fail closed on !merged).
	checkSHA := pr.MergeCommitSHA
	if checkSHA == "" {
		checkSHA = pr.HeadSHA
	}
	var checks []linearreconciler.CheckState
	var checksErr error
	if checkSHA != "" {
		checksFetched, err := gh.ListChecks(ctx, owner, repo, checkSHA)
		if err != nil {
			checksErr = err
		} else {
			checks = checksFetched
		}
	}
	// Wiki lint: fail closed on unavailable.
	var wikiClean *bool
	var wikiReason string
	var wikiErr error
	policy, policyErr := wikigovernance.LoadPolicy(resolvedRepo)
	if policyErr != nil {
		wikiErr = policyErr
	} else {
		// Rebuild-then-validate pattern: re-derive lint-equivalent cleanliness from ValidateRepository.
		// Concrete lint counts come from the installed llm-wiki lint; here we enforce the same
		// invariant: the repository's committable boundary must be clean.
		if err := policy.ValidateRepository(resolvedRepo); err != nil {
			b := false
			wikiClean = &b
			wikiReason = redactError(err).Error()
		} else {
			// Also ensure metadata is derivable without symlink/canonical errors.
			if _, err := policy.RebuildMetadata(resolvedRepo); err != nil {
				b := false
				wikiClean = &b
				wikiReason = redactError(err).Error()
			} else {
				b := true
				wikiClean = &b
			}
		}
	}
	if checksErr != nil {
		// Nil checks signals unavailable to the decision engine.
		checks = nil
	}

	// Linear observation (runtime-only).
	var linearIssue *linearreconciler.LinearIssueState
	if linKey != "" {
		lc := &linearreconciler.LinearGraphQLClient{APIKey: linKey, APIBase: os.Getenv("LINEAR_API_URL")}
		iss, err := lc.GetIssue(ctx, ticket)
		if err == nil {
			linearIssue = &iss
		} else {
			// Fail closed: without the linked issue we cannot safely transition.
			// Do not synthesize a transition; record unavailable.
		}
	}

	in := linearreconciler.Inputs{
		RepoRoot:     resolvedRepo,
		ManifestPath: resolvedManifest,
		PR: linearreconciler.PRState{
			Number:         pr.Number,
			Merged:         pr.Merged,
			Draft:          pr.Draft,
			MergeCommitSHA: pr.MergeCommitSHA,
			HeadSHA:        pr.HeadSHA,
			URL:            pr.HTMLURL,
		},
		Checks:           checks,
		LinearIssue:      linearIssue,
		WikiLintClean:    wikiClean,
		WikiLintReason:   wikiReason,
		WikiLintErr:      wikiErr,
		ManifestErr:      manifestErr,
		ManifestTicketID: manifestTicket,
		ManifestCommit:   manifestCommit,
		ManifestSHA256:   manifestSHA,
	}
	r := &linearreconciler.Reconciler{}
	decision, err := r.Decide(ctx, in)
	if err != nil {
		emitDecisionAndExit(&decision, err, "decide_failed", *outputPath, 2)
	}
	emitDecision(decision, *outputPath, 0)
	if !decision.ShouldTransition {
		if decision.AlreadyDone {
			os.Exit(0)
		}
		// Stay In Progress — no mutation, non-zero would retry in CI.
		// Exit 0 so the workflow does not mark delivery as failed when the
		// gate correctly stayed In Progress.
		os.Exit(0)
	}
	if *dryRun {
		fmt.Fprintln(os.Stderr, "dry-run: would transition", ticket, "to Done")
		os.Exit(0)
	}
	if linKey == "" {
		d2 := decision
		d2.Reason = "linear credentials unavailable"
		d2.ReasonCode = linearreconciler.CodeUnavailableState
		emitDecision(d2, *outputPath, 0)
		os.Exit(0)
	}
	lc := &linearreconciler.LinearGraphQLClient{APIKey: linKey, APIBase: os.Getenv("LINEAR_API_URL")}
	out, recErr := linearreconciler.Reconcile(ctx, r, lc, in)
	if recErr != nil {
		emitDecisionAndExit(&out.Decision, recErr, "transition_failed", *outputPath, 1)
	}
	emitDecision(out.Decision, *outputPath, 0)
	if out.Transitioned {
		fmt.Fprintf(os.Stderr, "reconciler: transitioned %s to Done (attempt %s)\n", ticket, out.Decision.AttemptID)
	}
}

func splitRepo(s string) (owner, repo string) {
	parts := strings.Split(strings.TrimSpace(s), "/")
	if len(parts) != 2 {
		return "", ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func mustAbs(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		fatalf("resolve %q: %v", p, err)
	}
	return a
}

func decisionShell(prNumber int, mergeSHA, ticket, manifest string, merged, draft bool) linearreconciler.Decision {
	return linearreconciler.Decision{
		Timestamp:      time.Now().UTC(),
		TicketID:       ticket,
		ManifestPath:   manifest,
		PRNumber:       prNumber,
		PRMerged:       merged,
		PRDraft:        draft,
		MergeCommitSHA: mergeSHA,
		AttemptID:      newAttemptID(prNumber, manifest, mergeSHA),
	}
}

func newAttemptID(prNumber int, manifest, sha string) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%d|%s|%s|%d", time.Now().UnixNano(), manifest, sha, prNumber)))
	return hex.EncodeToString(h[:8])
}

func redactError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	for _, s := range []string{"token", "secret", "password", "authorization", "bearer", "api_key", "apikey"} {
		if strings.Contains(lower, s) {
			return fmt.Errorf("redacted validation error")
		}
	}
	if len(msg) > 600 {
		msg = msg[:600]
	}
	return fmt.Errorf("%s", strings.ReplaceAll(strings.ReplaceAll(msg, "\n", " "), "\r", " "))
}

func emitDecision(d linearreconciler.Decision, path string, exitCode int) {
	// Never emit credentials. Decision already contains only safe fields.
	data, _ := json.MarshalIndent(d, "", "  ")
	fmt.Fprintln(os.Stderr, string(data))
	if path != "" {
		_ = os.MkdirAll(filepath.Dir(path), 0755)
		_ = os.WriteFile(path, append(data, '\n'), 0644)
	}
	// Do not write JSON to GITHUB_OUTPUT: multiline values require delimiter syntax
	// (<<EOF) and would otherwise fail with "Unable to process file command 'output'".
	// The reconciler decision is already persisted to the --out file and stderr.
	if exitCode != 0 {
		os.Exit(exitCode)
	}
}

func emitDecisionAndExit(d *linearreconciler.Decision, err error, code, path string, exitCode int) {
	var dec linearreconciler.Decision
	if d != nil {
		dec = *d
	} else {
		dec = linearreconciler.Decision{
			Timestamp:  time.Now().UTC(),
			Reason:     redactError(err).Error(),
			ReasonCode: code,
			AttemptID:  newAttemptID(0, "", ""),
		}
	}
	if dec.ReasonCode == "" {
		dec.ReasonCode = code
	}
	if dec.Reason == "" {
		dec.Reason = redactError(err).Error()
	}
	emitDecision(dec, path, exitCode)
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "linear-reconciler: "+format+"\n", args...)
	os.Exit(2)
}
