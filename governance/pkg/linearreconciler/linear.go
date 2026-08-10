package linearreconciler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// LinearGraphQLClient is the production Linear client. APIKey is runtime-only.
type LinearGraphQLClient struct {
	HTTPClient *http.Client
	APIKey     string
	APIBase    string // default https://api.linear.app/graphql
}

func (c *LinearGraphQLClient) apiBase() string {
	if c.APIBase != "" {
		return c.APIBase
	}
	return "https://api.linear.app/graphql"
}

func (c *LinearGraphQLClient) GetIssue(ctx context.Context, identifier string) (LinearIssueState, error) {
	query := `query($id: String!) { issue(id: $id) { id identifier state { type name } } }`
	// Try by identifier first (e.g. WORK-107), then by id.
	body, _ := json.Marshal(map[string]any{
		"query":     query,
		"variables": map[string]any{"id": identifier},
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", c.apiBase(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", c.APIKey)
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return LinearIssueState{}, fmt.Errorf("linear get issue %s: %w", identifier, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return LinearIssueState{}, fmt.Errorf("linear get issue %s: %s %s", identifier, resp.Status, redactValidationError(fmt.Errorf("%s", b)))
	}
	var out struct {
		Data struct {
			Issue *struct {
				ID         string `json:"id"`
				Identifier string `json:"identifier"`
				State      *struct {
					Type string `json:"type"`
					Name string `json:"name"`
				} `json:"state"`
			} `json:"issue"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return LinearIssueState{}, fmt.Errorf("decode linear issue: %w", err)
	}
	if len(out.Errors) > 0 {
		return LinearIssueState{}, fmt.Errorf("linear get issue %s: %s", identifier, out.Errors[0].Message)
	}
	if out.Data.Issue == nil {
		return LinearIssueState{}, fmt.Errorf("linear issue %s not found", identifier)
	}
	st := out.Data.Issue.State
	statusType, statusName := "", ""
	if st != nil {
		statusType = st.Type
		statusName = st.Name
	}
	return LinearIssueState{
		ID:         out.Data.Issue.ID,
		Identifier: out.Data.Issue.Identifier,
		StatusType: statusType,
		StatusName: statusName,
	}, nil
}

func (c *LinearGraphQLClient) TransitionToDone(ctx context.Context, issueID string) error {
	// Linear transitions via issueUpdate with stateId for Done. We look up the
	// Done state id from workflowStates for the issue's team, then update.
	// For simplicity and to avoid extra calls, attempt the known mutation
	// that sets state to completed; if the team uses custom Done names the
	// caller must supply the correct mutation via an adapter. Here we use the
	// generic completed state id lookup.
	teamStateID, err := c.lookupDoneStateID(ctx, issueID)
	if err != nil {
		return err
	}
	mutation := `mutation($id: ID!, $stateId: ID!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { type name } } } }`
	body, _ := json.Marshal(map[string]any{
		"query": mutation,
		"variables": map[string]any{
			"id":      issueID,
			"stateId": teamStateID,
		},
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", c.apiBase(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", c.APIKey)
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("linear transition %s: %w", issueID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("linear transition %s: %s %s", issueID, resp.Status, redactValidationError(fmt.Errorf("%s", b)))
	}
	var out struct {
		Data struct {
			IssueUpdate *struct {
				Success bool `json:"success"`
			} `json:"issueUpdate"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("decode linear transition: %w", err)
	}
	if len(out.Errors) > 0 {
		return fmt.Errorf("linear transition %s: %s", issueID, out.Errors[0].Message)
	}
	if out.Data.IssueUpdate == nil || !out.Data.IssueUpdate.Success {
		return fmt.Errorf("linear transition %s not successful", issueID)
	}
	return nil
}

func (c *LinearGraphQLClient) lookupDoneStateID(ctx context.Context, issueID string) (string, error) {
	// Fetch issue's team, then workflowStates for that team, pick completed.
	query := `query($id: ID!) { issue(id: $id) { team { id } } }`
	body, _ := json.Marshal(map[string]any{
		"query":     query,
		"variables": map[string]any{"id": issueID},
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", c.apiBase(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", c.APIKey)
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("linear team lookup: %w", err)
	}
	defer resp.Body.Close()
	var teamOut struct {
		Data struct {
			Issue *struct {
				Team *struct {
					ID string `json:"id"`
				} `json:"team"`
			} `json:"issue"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&teamOut); err != nil {
		return "", fmt.Errorf("decode team: %w", err)
	}
	teamID := ""
	if teamOut.Data.Issue != nil && teamOut.Data.Issue.Team != nil {
		teamID = teamOut.Data.Issue.Team.ID
	}
	if teamID == "" {
		return "", fmt.Errorf("team id unavailable for %s", issueID)
	}
	wfQuery := `query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "completed" } }) { nodes { id type name } } }`
	wfBody, _ := json.Marshal(map[string]any{
		"query":     wfQuery,
		"variables": map[string]any{"teamId": teamID},
	})
	req2, _ := http.NewRequestWithContext(ctx, "POST", c.apiBase(), bytes.NewReader(wfBody))
	req2.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req2.Header.Set("Authorization", c.APIKey)
	}
	resp2, err := client.Do(req2)
	if err != nil {
		return "", fmt.Errorf("linear workflow states: %w", err)
	}
	defer resp2.Body.Close()
	var wfOut struct {
		Data struct {
			WorkflowStates *struct {
				Nodes []struct {
					ID   string `json:"id"`
					Type string `json:"type"`
					Name string `json:"name"`
				} `json:"nodes"`
			} `json:"workflowStates"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&wfOut); err != nil {
		return "", fmt.Errorf("decode workflow states: %w", err)
	}
	if len(wfOut.Errors) > 0 {
		return "", fmt.Errorf("linear workflow states: %s", wfOut.Errors[0].Message)
	}
	if wfOut.Data.WorkflowStates != nil {
		for _, n := range wfOut.Data.WorkflowStates.Nodes {
			if strings.EqualFold(n.Type, "completed") || strings.EqualFold(n.Name, "Done") {
				return n.ID, nil
			}
		}
		if len(wfOut.Data.WorkflowStates.Nodes) > 0 {
			return wfOut.Data.WorkflowStates.Nodes[0].ID, nil
		}
	}
	return "", fmt.Errorf("no completed workflow state for team %s", teamID)
}
