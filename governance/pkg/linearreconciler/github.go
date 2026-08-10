package linearreconciler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// GitHubPR is the minimal PR view needed for reconciliation.
type GitHubPR struct {
	Number         int    `json:"number"`
	Merged         bool   `json:"merged"`
	Draft          bool   `json:"draft"`
	MergeCommitSHA string `json:"merge_commit_sha"`
	HeadSHA        string `json:"head_sha"`
	BaseSHA        string `json:"base_sha"`
	HTMLURL        string `json:"html_url"`
	Body           string `json:"body"`
	Title          string `json:"title"`
	State          string `json:"state"`
}

// GitHubChecksResponse is a subset of the GitHub Checks/Status API used to
// evaluate required checks.
type GitHubChecksResponse struct {
	CheckRuns []struct {
		Name       string `json:"name"`
		Conclusion string `json:"conclusion"`
		Status     string `json:"status"`
	} `json:"check_runs"`
	Statuses []struct {
		Context string `json:"context"`
		State   string `json:"state"`
	} `json:"statuses"`
}

// GitHubClient fetches PR and check state. Production uses net/http with a
// runtime-only token; tests inject a fake.
type GitHubClient interface {
	GetPR(ctx context.Context, owner, repo string, number int) (GitHubPR, error)
	ListChecks(ctx context.Context, owner, repo, sha string) ([]CheckState, error)
}

var ticketInText = regexp.MustCompile(`\b([A-Z][A-Z0-9]+-[1-9][0-9]*)\b`)

// ExtractTicket scans PR title/body for the first ticket identifier. Returns
// empty when no identifier is present (caller treats as not-linked).
func ExtractTicket(title, body string) string {
	for _, m := range ticketInText.FindAllStringSubmatch(title+" "+body, -1) {
		candidate := m[1]
		if ticketIDRe.MatchString(candidate) {
			return candidate
		}
	}
	return ""
}

// HTTPGitHubClient is the production GitHub client. Token is runtime-only and
// never logged.
type HTTPGitHubClient struct {
	HTTPClient *http.Client
	Token      string
	APIBase    string // default https://api.github.com
}

func (c *HTTPGitHubClient) apiBase() string {
	if c.APIBase != "" {
		return strings.TrimRight(c.APIBase, "/")
	}
	return "https://api.github.com"
}

func (c *HTTPGitHubClient) GetPR(ctx context.Context, owner, repo string, number int) (GitHubPR, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d", c.apiBase(), owner, repo, number)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.do(req)
	if err != nil {
		return GitHubPR{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return GitHubPR{}, fmt.Errorf("github get PR %d: %s %s", number, resp.Status, redactBody(string(body)))
	}
	var raw struct {
		Number         int    `json:"number"`
		Merged         bool   `json:"merged"`
		Draft          bool   `json:"draft"`
		MergeCommitSHA string `json:"merge_commit_sha"`
		Head           struct {
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			SHA string `json:"sha"`
		} `json:"base"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
		Title   string `json:"title"`
		State   string `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return GitHubPR{}, fmt.Errorf("decode PR: %w", err)
	}
	return GitHubPR{
		Number:         raw.Number,
		Merged:         raw.Merged,
		Draft:          raw.Draft,
		MergeCommitSHA: strings.ToLower(strings.TrimSpace(raw.MergeCommitSHA)),
		HeadSHA:        strings.ToLower(strings.TrimSpace(raw.Head.SHA)),
		BaseSHA:        strings.ToLower(strings.TrimSpace(raw.Base.SHA)),
		HTMLURL:        raw.HTMLURL,
		Body:           raw.Body,
		Title:          raw.Title,
		State:          raw.State,
	}, nil
}

func (c *HTTPGitHubClient) ListChecks(ctx context.Context, owner, repo, sha string) ([]CheckState, error) {
	if sha == "" {
		return nil, fmt.Errorf("sha required")
	}
	// Prefer Checks API; fall back to combined status is handled by caller.
	// We call both and merge.
	var out []CheckState
	// Check runs (newer)
	checkURL := fmt.Sprintf("%s/repos/%s/%s/commits/%s/check-runs", c.apiBase(), owner, repo, sha)
	req, _ := http.NewRequestWithContext(ctx, "GET", checkURL, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			var cr GitHubChecksResponse
			_ = json.NewDecoder(resp.Body).Decode(&cr)
			for _, r := range cr.CheckRuns {
				out = append(out, CheckState{Name: r.Name, Conclusion: r.Conclusion})
			}
		}
	}
	// Combined statuses (older workflows)
	statusURL := fmt.Sprintf("%s/repos/%s/%s/commits/%s/status", c.apiBase(), owner, repo, sha)
	req2, _ := http.NewRequestWithContext(ctx, "GET", statusURL, nil)
	req2.Header.Set("Accept", "application/vnd.github+json")
	if c.Token != "" {
		req2.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp2, err := c.do(req2)
	if err == nil {
		defer resp2.Body.Close()
		if resp2.StatusCode == 200 {
			var sr struct {
				Statuses []struct {
					Context string `json:"context"`
					State   string `json:"state"`
				} `json:"statuses"`
			}
			_ = json.NewDecoder(resp2.Body).Decode(&sr)
			for _, s := range sr.Statuses {
				out = append(out, CheckState{Name: s.Context, Conclusion: s.State})
			}
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no checks observed for %s", sha[:7])
	}
	return out, nil
}

func (c *HTTPGitHubClient) do(req *http.Request) (*http.Response, error) {
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(req)
}

func redactBody(body string) string {
	if len(body) > 500 {
		body = body[:500]
	}
	lower := strings.ToLower(body)
	for _, s := range []string{"token", "secret", "authorization", "bearer"} {
		if strings.Contains(lower, s) {
			return "redacted"
		}
	}
	return body
}
