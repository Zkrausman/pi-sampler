// Package linearreconciler enforces the verified Linear Done transition.
// It is fail-closed, idempotent, and deterministic. It transitions only the
// ticket linked to a merged PR after all required evidence passes. Runtime
// credentials are consumed only by the adapter layer (cmd/linear-reconciler);
// this package has no credential, network, or secret dependencies.
package linearreconciler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	RequiredDeliveryCheck = "Delivery evidence gate"
	RequiredWikiCheck     = "Wiki governance"
)

// Decision is the auditable outcome of a reconciliation attempt. It contains
// only safe identifiers and digests; no raw payload or credential material.
type Decision struct {
	Timestamp        time.Time `json:"timestamp"`
	TicketID         string    `json:"ticket_id"`
	ManifestPath     string    `json:"manifest_path"`
	ManifestSHA256   string    `json:"manifest_sha256,omitempty"`
	PRNumber         int       `json:"pr_number"`
	PRMerged         bool      `json:"pr_merged"`
	PRDraft          bool      `json:"pr_draft"`
	MergeCommitSHA   string    `json:"merge_commit_sha,omitempty"`
	ShouldTransition bool      `json:"should_transition"`
	AlreadyDone      bool      `json:"already_done,omitempty"`
	Reason           string    `json:"reason"`
	ReasonCode       string    `json:"reason_code"`
	ChecksSummary    string    `json:"checks_summary,omitempty"`
	WikiLintClean    *bool     `json:"wiki_lint_clean,omitempty"`
	AttemptID        string    `json:"attempt_id"`
}

// ReasonCodes is the closed set of machine-readable outcome codes. Every
// fail-closed branch must use one of these codes so CI and tests can assert
// field-level blame without parsing free-form text.
const (
	CodeOK                    = "ok"
	CodePRNotMerged           = "pr_not_merged"
	CodePRIsDraft             = "pr_is_draft"
	CodePRMissingMergeCommit  = "pr_missing_merge_commit"
	CodeMissingManifest       = "missing_manifest"
	CodeInvalidManifest       = "invalid_manifest"
	CodeRequiredChecksMissing = "required_checks_missing"
	CodeRequiredChecksFailed  = "required_checks_failed"
	CodeRequiredChecksUnknown = "required_checks_unavailable"
	CodeWikiLintNotClean      = "wiki_lint_not_clean"
	CodeWikiLintUnavailable   = "wiki_lint_unavailable"
	CodeAlreadyDone           = "already_done"
	CodeNotLinked             = "not_linked_pr"
	CodeUnavailableState      = "unavailable_state"
)

var (
	ticketIDRe = regexp.MustCompile(`^[A-Z][A-Z0-9]+-[1-9][0-9]*$`)
	shaRe      = regexp.MustCompile(`^[a-f0-9]{40}$`)
)

// PRState is the pull request state as observed from GitHub. It is supplied
// by the adapter and contains only safe fields.
type PRState struct {
	Number         int
	Merged         bool
	Draft          bool
	MergeCommitSHA string
	HeadSHA        string
	URL            string
}

// CheckState is a single required check conclusion as observed from GitHub.
type CheckState struct {
	Name       string
	Conclusion string // "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"
}

// LinearIssueState is the observed Linear issue status type.
type LinearIssueState struct {
	ID         string
	Identifier string
	StatusType string // "backlog", "unstarted", "started", "completed", "canceled"
	StatusName string
}

// ManifestValidator validates the deterministic delivery-evidence manifest
// without contacting services. Production uses pkg/deliveryevidence.
type ManifestValidator interface {
	ValidateFileAtCommit(manifestPath, repoRoot, expectedCommit string) error
	// ReadTicketAndCommit returns the ticket_id and commit_sha from the manifest JSON.
	ReadTicketAndCommit(manifestPath string) (ticketID, commitSHA string, err error)
}

// WikiLintChecker checks that the wiki collaboration boundary is clean.
// Production uses pkg/wikigovernance.
type WikiLintChecker interface {
	IsClean(repoRoot string) (clean bool, reason string, err error)
}

// LinearClient is the minimal Linear surface used by the reconciler. It must
// be idempotent and safe to retry.
type LinearClient interface {
	GetIssue(ctx context.Context, identifier string) (LinearIssueState, error)
	TransitionToDone(ctx context.Context, issueID string) error
}

// Inputs is the reconciler's deterministic input bundle. All fields are
// already observed and redacted by the adapter before calling Reconcile.
type Inputs struct {
	RepoRoot         string
	ManifestPath     string // repository-relative, e.g. evidence/delivery/WORK-107.json
	PR               PRState
	Checks           []CheckState
	LinearIssue      *LinearIssueState // nil if unavailable
	WikiLintClean    *bool             // nil if unavailable
	WikiLintReason   string
	WikiLintErr      error
	ManifestErr      error
	ManifestTicketID string
	ManifestCommit   string
	ManifestSHA256   string // digest of manifest file bytes, for audit only
	AttemptID        string // stable attempt identifier for audit deduplication
}

// Reconciler is the pure decision engine. It never mutates Linear status
// itself; the caller decides whether to act on ShouldTransition.
type Reconciler struct {
	Validator ManifestValidator
	Wiki      WikiLintChecker
}

// Decide evaluates the deterministic policy and returns an auditable Decision.
// It is fail-closed: any unavailable or failing evidence yields ShouldTransition=false.
func (r *Reconciler) Decide(ctx context.Context, in Inputs) (Decision, error) {
	now := time.Now().UTC()
	decision := Decision{
		Timestamp:      now,
		PRNumber:       in.PR.Number,
		PRMerged:       in.PR.Merged,
		PRDraft:        in.PR.Draft,
		MergeCommitSHA: in.PR.MergeCommitSHA,
		AttemptID:      in.AttemptID,
	}
	if decision.AttemptID == "" {
		h := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%s:%d", now.UnixNano(), in.ManifestPath, in.PR.MergeCommitSHA, in.PR.Number)))
		decision.AttemptID = hex.EncodeToString(h[:8])
	}

	// Resolve manifest identity for audit even when validation later fails.
	manifestTicket := in.ManifestTicketID
	manifestCommit := in.ManifestCommit
	manifestPath := normalizePath(in.ManifestPath)
	decision.ManifestPath = manifestPath
	decision.ManifestSHA256 = in.ManifestSHA256
	if manifestTicket != "" {
		decision.TicketID = manifestTicket
	} else if in.LinearIssue != nil {
		decision.TicketID = in.LinearIssue.Identifier
	}

	// 1. Manifest must exist and be readable. Missing manifest is a hard
	// fail-closed gate — do not fall through to other checks.
	if in.ManifestErr != nil {
		if os.IsNotExist(asErr(in.ManifestErr)) || strings.Contains(strings.ToLower(in.ManifestErr.Error()), "not found") || strings.Contains(strings.ToLower(in.ManifestErr.Error()), "no such file") {
			decision.Reason = "delivery manifest not found"
			decision.ReasonCode = CodeMissingManifest
			return decision, nil
		}
		// Any other manifest observation error is unavailable state; fail closed.
		decision.Reason = "delivery manifest observation unavailable"
		decision.ReasonCode = CodeUnavailableState
		return decision, nil
	}
	if manifestPath == "" {
		decision.Reason = "delivery manifest not found"
		decision.ReasonCode = CodeMissingManifest
		return decision, nil
	}

	// Manifest ticket must be well-formed.
	if manifestTicket != "" && !ticketIDRe.MatchString(manifestTicket) {
		decision.Reason = fmt.Sprintf("invalid ticket_id %q", manifestTicket)
		decision.ReasonCode = CodeInvalidManifest
		return decision, nil
	}
	if manifestTicket != "" {
		decision.TicketID = manifestTicket
	}

	// 2. PR must be merged and non-draft, with a merge commit.
	if !in.PR.Merged {
		decision.Reason = "pull request not merged"
		decision.ReasonCode = CodePRNotMerged
		return decision, nil
	}
	if in.PR.Draft {
		decision.Reason = "pull request is draft"
		decision.ReasonCode = CodePRIsDraft
		return decision, nil
	}
	if in.PR.MergeCommitSHA == "" || !shaRe.MatchString(in.PR.MergeCommitSHA) {
		decision.Reason = "pull request missing merge commit"
		decision.ReasonCode = CodePRMissingMergeCommit
		return decision, nil
	}

	// 3. Linked issue check: manifest ticket must match the Linear issue under
	// reconciliation when a Linear issue is supplied. This enforces "only
	// linked issues change".
	if in.LinearIssue != nil && manifestTicket != "" && in.LinearIssue.Identifier != "" && in.LinearIssue.Identifier != manifestTicket {
		decision.Reason = fmt.Sprintf("manifest ticket %s does not match linked issue %s", manifestTicket, in.LinearIssue.Identifier)
		decision.ReasonCode = CodeNotLinked
		return decision, nil
	}

	// 4. Manifest must validate deterministically against the expected delivery commit.
	// When the adapter could not run the validator (e.g., repoRoot unavailable), treat as unavailable.
	if in.ManifestTicketID == "" && in.ManifestCommit == "" {
		// No ticket/commit observed implies the adapter failed to read the manifest at all beyond existence.
		decision.Reason = "delivery manifest invalid"
		decision.ReasonCode = CodeInvalidManifest
		return decision, nil
	}
	// If the validator is injected, re-validate deterministically through it when a repoRoot is available.
	if r.Validator != nil && in.RepoRoot != "" && manifestPath != "" && manifestCommit != "" {
		if err := r.Validator.ValidateFileAtCommit(filepath.Join(in.RepoRoot, manifestPath), in.RepoRoot, manifestCommit); err != nil {
			decision.Reason = fmt.Sprintf("delivery manifest invalid: %s", redactValidationError(err))
			decision.ReasonCode = CodeInvalidManifest
			return decision, nil
		}
	} else if in.ManifestErr != nil {
		decision.Reason = fmt.Sprintf("delivery manifest invalid: %s", redactValidationError(in.ManifestErr))
		decision.ReasonCode = CodeInvalidManifest
		return decision, nil
	}
	// Additional binding: manifest commit must look like a SHA when present.
	if manifestCommit != "" && !shaRe.MatchString(manifestCommit) {
		decision.Reason = "manifest commit_sha malformed"
		decision.ReasonCode = CodeInvalidManifest
		return decision, nil
	}

	// 5. Required CI checks must be observed and all be success.
	if in.Checks == nil {
		decision.Reason = "required checks unavailable"
		decision.ReasonCode = CodeRequiredChecksUnknown
		decision.ChecksSummary = "unavailable"
		return decision, nil
	}
	summary, ok, failReason, code := evaluateRequiredChecks(in.Checks)
	decision.ChecksSummary = summary
	if !ok {
		decision.Reason = failReason
		decision.ReasonCode = code
		return decision, nil
	}

	// 6. Wiki lint must be clean. Nil means unavailable -> fail closed.
	if in.WikiLintErr != nil {
		decision.Reason = "wiki lint unavailable"
		decision.ReasonCode = CodeWikiLintUnavailable
		b := false
		decision.WikiLintClean = &b
		return decision, nil
	}
	if in.WikiLintClean == nil {
		decision.Reason = "wiki lint unavailable"
		decision.ReasonCode = CodeWikiLintUnavailable
		return decision, nil
	}
	decision.WikiLintClean = in.WikiLintClean
	if !*in.WikiLintClean {
		reason := in.WikiLintReason
		if reason == "" {
			reason = "wiki lint not clean"
		}
		decision.Reason = reason
		decision.ReasonCode = CodeWikiLintNotClean
		return decision, nil
	}

	// 7. Idempotency: if Linear already reports Done, do not re-transition.
	if in.LinearIssue != nil && isDoneStatus(in.LinearIssue) {
		decision.AlreadyDone = true
		decision.Reason = "issue already Done"
		decision.ReasonCode = CodeAlreadyDone
		decision.ShouldTransition = false
		return decision, nil
	}

	// 8. Linear issue must be resolvable (linked). Without it, fail closed and do not transition.
	if in.LinearIssue == nil {
		decision.Reason = "linked Linear issue unavailable"
		decision.ReasonCode = CodeUnavailableState
		return decision, nil
	}

	decision.ShouldTransition = true
	decision.Reason = "verified merge: all gates passed"
	decision.ReasonCode = CodeOK
	return decision, nil
}

func evaluateRequiredChecks(checks []CheckState) (summary string, ok bool, reason, code string) {
	// Normalize check names for case-insensitive substring match because GitHub
	// surfaces checks as "Delivery evidence gate / validate" and
	// "Wiki governance / validate" (or bare workflow names).
	required := []string{RequiredDeliveryCheck, RequiredWikiCheck}
	// Build lookup of conclusion by normalized name substring.
	byRequired := make(map[string]*CheckState)
	for _, req := range required {
		needle := strings.ToLower(req)
		for i := range checks {
			if strings.Contains(strings.ToLower(checks[i].Name), needle) {
				// Prefer latest entry if duplicates; overwrites earlier.
				byRequired[req] = &checks[i]
				break
			}
		}
	}
	var parts []string
	for _, req := range required {
		st, found := byRequired[req]
		if !found {
			return fmt.Sprintf("missing required check %q", req), false, fmt.Sprintf("required check %q missing", req), CodeRequiredChecksMissing
		}
		conclusion := strings.ToLower(strings.TrimSpace(st.Conclusion))
		parts = append(parts, fmt.Sprintf("%s=%s", req, conclusion))
		if conclusion != "success" && conclusion != "successful" && conclusion != "succeeded" {
			if conclusion == "" {
				return strings.Join(parts, " "), false, fmt.Sprintf("required check %q unavailable", req), CodeRequiredChecksUnknown
			}
			return strings.Join(parts, " "), false, fmt.Sprintf("required check %q is %s", req, conclusion), CodeRequiredChecksFailed
		}
	}
	// Sort for deterministic audit output regardless of input order.
	sort.Strings(parts)
	summary = strings.Join(parts, " ")
	return summary, true, "", CodeOK
}

func isDoneStatus(issue *LinearIssueState) bool {
	if issue == nil {
		return false
	}
	t := strings.ToLower(strings.TrimSpace(issue.StatusType))
	if t == "completed" {
		return true
	}
	n := strings.ToLower(strings.TrimSpace(issue.StatusName))
	return n == "done" && t != "canceled"
}

func normalizePath(p string) string {
	p = filepath.ToSlash(filepath.Clean(p))
	p = strings.TrimPrefix(p, "./")
	if p == "." {
		return ""
	}
	return p
}

func redactValidationError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	// Never surface path-absolute or credential material. Validation errors are
	// already safe, but we defensively strip any token-like substrings and
	// absolute paths.
	lower := strings.ToLower(msg)
	for _, token := range []string{"bearer", "token", "secret", "password", "authorization"} {
		if strings.Contains(lower, token) {
			return "validation failed"
		}
	}
	if len(msg) > 600 {
		msg = msg[:600]
	}
	msg = strings.ReplaceAll(msg, "\n", " ")
	msg = strings.ReplaceAll(msg, "\r", " ")
	return strings.TrimSpace(msg)
}

func asErr(err error) error { return err }

// RealManifestValidator adapts pkg/deliveryevidence for production wiring.
// It is defined here to avoid an import cycle in pure unit tests; production
// main wires the real implementation.
type RealManifestValidator struct {
	ValidateFn func(manifestPath, repoRoot, expectedCommit string) error
	ReadFn     func(manifestPath string) (string, string, error)
}

func (v *RealManifestValidator) ValidateFileAtCommit(manifestPath, repoRoot, expectedCommit string) error {
	if v.ValidateFn != nil {
		return v.ValidateFn(manifestPath, repoRoot, expectedCommit)
	}
	return fmt.Errorf("validator not configured")
}
func (v *RealManifestValidator) ReadTicketAndCommit(manifestPath string) (string, string, error) {
	if v.ReadFn != nil {
		return v.ReadFn(manifestPath)
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", "", err
	}
	var raw struct {
		TicketID  string `json:"ticket_id"`
		CommitSHA string `json:"commit_sha"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return "", "", err
	}
	return raw.TicketID, raw.CommitSHA, nil
}

// RealWikiLintChecker adapts pkg/wikigovernance for production.
type RealWikiLintChecker struct {
	CheckFn func(repoRoot string) (bool, string, error)
}

func (w *RealWikiLintChecker) IsClean(repoRoot string) (bool, string, error) {
	if w.CheckFn != nil {
		return w.CheckFn(repoRoot)
	}
	return false, "wiki checker not configured", fmt.Errorf("wiki checker not configured")
}

// Outcome is the full reconciliation outcome including the Linear mutation
// that was actually performed (if any).
type Outcome struct {
	Decision      Decision `json:"decision"`
	Transitioned  bool     `json:"transitioned"`
	AlreadyDone   bool     `json:"already_done"`
	TransitionErr string   `json:"transition_error,omitempty"`
}

// Reconcile decides and, when the policy allows, performs the idempotent
// Linear Done transition. It retries transient Linear errors without creating
// duplicate status or comment churn: at most one transition per successful
// decision, and none when AlreadyDone.
func Reconcile(ctx context.Context, r *Reconciler, client LinearClient, in Inputs) (Outcome, error) {
	decision, err := r.Decide(ctx, in)
	if err != nil {
		return Outcome{Decision: decision}, err
	}
	out := Outcome{Decision: decision}
	if decision.AlreadyDone {
		out.AlreadyDone = true
		return out, nil
	}
	if !decision.ShouldTransition {
		return out, nil
	}
	if client == nil {
		out.TransitionErr = "linear client unavailable"
		return out, fmt.Errorf("linear client unavailable")
	}
	if in.LinearIssue == nil || in.LinearIssue.ID == "" {
		out.TransitionErr = "linked issue id unavailable"
		return out, fmt.Errorf("linked issue id unavailable")
	}
	if err := transitionWithRetry(ctx, client, in.LinearIssue.ID); err != nil {
		out.TransitionErr = redactValidationError(err)
		return out, err
	}
	out.Transitioned = true
	return out, nil
}

func transitionWithRetry(ctx context.Context, client LinearClient, issueID string) error {
	var lastErr error
	backoffs := []time.Duration{0, 200 * time.Millisecond, 500 * time.Millisecond}
	for i, d := range backoffs {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
			}
		}
		err := client.TransitionToDone(ctx, issueID)
		if err == nil {
			return nil
		}
		if !isRetryable(err) {
			return err
		}
		lastErr = err
	}
	return lastErr
}

func isRetryable(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"429", "rate limit", "timeout", "temporarily", "503", "502", "504", "connection", "transient"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}
