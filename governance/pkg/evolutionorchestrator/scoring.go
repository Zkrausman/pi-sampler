package evolutionorchestrator

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

// LedgerStats is a deterministic, redacted aggregate for one harness strand.
// No raw transcripts, digests only.
type LedgerStats struct {
	Harness               string   `json:"harness"` // pi | claude | unknown
	SampleSize            int      `json:"sample_size"`
	FirstPassApprovalRate *float64 `json:"first_pass_approval_rate,omitempty"`
	FeedbackRoundsMedian  *float64 `json:"feedback_rounds_median,omitempty"`
	LeadTimeMedianMs      *int     `json:"lead_time_median_ms,omitempty"`
	UnknownCounts         int      `json:"unknown_counts"`
	DeterministicID       string   `json:"deterministic_id"`
	HasData               bool     `json:"has_data"`
}

// LedgerScore is the SkillOpt held-out score for a promotion candidate.
// It is NEVER synthesized: fail-closed when ledger empty/unknown.
type LedgerScore struct {
	HarnessScores map[string]LedgerStats `json:"harness_scores"`
	Baseline      LedgerStats            `json:"baseline"`
	// Delta vs baseline for the scoring harness (pi).
	DeltaFirstPass      *float64 `json:"delta_first_pass,omitempty"`
	DeltaFeedbackRounds *float64 `json:"delta_feedback_rounds,omitempty"`
	DeltaLeadTimeMs     *int     `json:"delta_lead_time_ms,omitempty"`
	JustifiesPromotion  bool     `json:"justifies_promotion"`
	ScoredHarness       string   `json:"scored_harness"`
	Rationale           string   `json:"rationale"`
	DeterministicID     string   `json:"deterministic_id"`
	SourceLedger        string   `json:"source_ledger"` // must be repo-relative, never per-machine StoragePath
	HasData             bool     `json:"has_data"`
	// Gate stays locked: scoring never auto-activates.
	RequiresHumanMerge bool `json:"requires_human_merge"`
	RequiresValidator  bool `json:"requires_validator"`
}

// ScoreCandidate computes a SkillOpt executive score from held-out ledger metrics.
// LedgerIsSoleTruth: input is LedgerSnapshot derived from evaluation-ledger/metrics.
// Fail-closed: if HasData==false or sample too small, JustifiesPromotion=false and Rationale explains.
//
// This is the SkillOpt strategy (held-out performance), NOT TextGrad. Scoring only;
// the independent validator + human merge gate stays locked.
func ScoreCandidate(snapshot LedgerSnapshot, baseline LedgerStats) LedgerScore {
	// Canonical ledger path — deterministic, not per-machine.
	sourceLedger := ".pi/tmp/controller/jobs.ndjson"
	deterministicID := sha256Hex(fmt.Sprintf("score:%d:%s:%f", snapshot.TotalRecords, baseline.DeterministicID, 0.0))

	piStats, ok := snapshot.ByHarness["pi"]
	if !ok || !piStats.HasData || piStats.SampleSize < 2 {
		return LedgerScore{
			HarnessScores:      snapshot.ByHarness,
			Baseline:           baseline,
			ScoredHarness:      "pi",
			Rationale:          "fail-closed: ledger empty/unknown or insufficient pi samples (<2); no synthetic metrics",
			DeterministicID:    deterministicID,
			SourceLedger:       sourceLedger,
			HasData:            false,
			RequiresHumanMerge: true,
			RequiresValidator:  true,
		}
	}
	if snapshot.TotalRecords == 0 || !snapshot.HasData {
		return LedgerScore{
			HarnessScores:      snapshot.ByHarness,
			Baseline:           baseline,
			ScoredHarness:      "pi",
			Rationale:          "fail-closed: ledger absent/empty; no fake data (evaluation-ledger is sole truth)",
			DeterministicID:    deterministicID,
			SourceLedger:       sourceLedger,
			HasData:            false,
			RequiresHumanMerge: true,
			RequiresValidator:  true,
		}
	}
	// Compute deltas vs baseline where both known.
	var deltaFirstPass *float64
	if piStats.FirstPassApprovalRate != nil && baseline.FirstPassApprovalRate != nil {
		d := *piStats.FirstPassApprovalRate - *baseline.FirstPassApprovalRate
		deltaFirstPass = &d
	}
	var deltaLeadTime *int
	if piStats.LeadTimeMedianMs != nil && baseline.LeadTimeMedianMs != nil {
		d := *piStats.LeadTimeMedianMs - *baseline.LeadTimeMedianMs
		deltaLeadTime = &d
	}
	var deltaFeedback *float64
	if piStats.FeedbackRoundsMedian != nil && baseline.FeedbackRoundsMedian != nil {
		d := *piStats.FeedbackRoundsMedian - *baseline.FeedbackRoundsMedian
		deltaFeedback = &d
	}
	// SkillOpt justification: any positive first-pass delta or negative lead/rounds delta with sufficient sample.
	justifies := false
	if deltaFirstPass != nil && *deltaFirstPass > 0 {
		justifies = true
	}
	if deltaLeadTime != nil && *deltaLeadTime < 0 {
		justifies = true
	}
	if deltaFeedback != nil && *deltaFeedback < 0 {
		justifies = true
	}
	rationale := fmt.Sprintf("held-out pi: firstPass delta=%v leadTime delta=%v feedback delta=%v; baseline_id=%s pi_id=%s", formatFloatPtr(deltaFirstPass), formatIntPtr(deltaLeadTime), formatFloatPtr(deltaFeedback), truncate(baseline.DeterministicID, 12), truncate(piStats.DeterministicID, 12))
	return LedgerScore{
		HarnessScores:       snapshot.ByHarness,
		Baseline:            baseline,
		DeltaFirstPass:      deltaFirstPass,
		DeltaLeadTimeMs:     deltaLeadTime,
		DeltaFeedbackRounds: deltaFeedback,
		JustifiesPromotion:  justifies,
		ScoredHarness:       "pi",
		Rationale:           rationale,
		DeterministicID:     deterministicID,
		SourceLedger:        sourceLedger,
		HasData:             true,
		RequiresHumanMerge:  true,
		RequiresValidator:   true,
	}
}

// LedgerSnapshot is the deterministic view derived from evaluation-metrics ledger truth.
// ByHarness is keyed by harness classification (pi | claude | unknown) — pi separate from unknown/claude.
// Not per-machine StoragePath: root is canonical repo-relative.
type LedgerSnapshot struct {
	TotalRecords int                    `json:"total_records"`
	HasData      bool                   `json:"has_data"`
	ByHarness    map[string]LedgerStats `json:"by_harness"`
}

// ClassifyHarness mirrors evaluation-metrics harness stratification.
// skill_version containing "pi" => pi, containing "claude" => claude, else unknown.
func ClassifyHarness(skillVersion string) string {
	lower := ""
	for _, c := range skillVersion {
		if c >= 'A' && c <= 'Z' {
			lower += string(c - 'A' + 'a')
		} else {
			lower += string(c)
		}
	}
	contains := func(s, sub string) bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	}
	if contains(lower, "pi") {
		return "pi"
	}
	if contains(lower, "claude") {
		return "claude"
	}
	return "unknown"
}

func deterministicIDForStats(s LedgerStats) string {
	keys := []string{s.Harness, fmt.Sprintf("%d", s.SampleSize)}
	if s.FirstPassApprovalRate != nil {
		keys = append(keys, fmt.Sprintf("%.4f", *s.FirstPassApprovalRate))
	}
	if s.LeadTimeMedianMs != nil {
		keys = append(keys, fmt.Sprintf("%d", *s.LeadTimeMedianMs))
	}
	sort.Strings(keys)
	sum := sha256.Sum256([]byte(fmt.Sprintf("%v", keys)))
	return hex.EncodeToString(sum[:])
}

func formatFloatPtr(v *float64) string {
	if v == nil {
		return "unknown"
	}
	return fmt.Sprintf("%.3f", *v)
}
func formatIntPtr(v *int) string {
	if v == nil {
		return "unknown"
	}
	return fmt.Sprintf("%d", *v)
}
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
