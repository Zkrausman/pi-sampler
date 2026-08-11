import { HindsightWorkError } from "./hindsight-work.mjs";

export const ISSUE_CREATE_MUTATION = `mutation HindsightIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id url team { id } state { name } }
  }
}`;

export const ISSUE_LOOKUP_QUERY = `query HindsightIssueLookup($id: String!) {
  issue(id: $id) { id url team { id } state { name } }
}`;

function issueFromResponse(issue, configuredTeamId) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)
    || typeof issue.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(issue.id)
    || typeof issue.url !== "string" || !isHttpsUrl(issue.url)
    || typeof issue.state?.name !== "string" || !issue.state.name.trim() || Array.from(issue.state.name).length > 160) {
    throw new HindsightWorkError("invalid_linear_response");
  }
  if (issue.team?.id !== configuredTeamId) throw new HindsightWorkError("team_mismatch");
  return { id: issue.id, url: issue.url, status: issue.state.name.trim() };
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.href === value;
  } catch {
    return false;
  }
}

/**
 * Narrow Linear GraphQL adapter: it can create one explicitly confirmed issue
 * or resolve one explicit issue ID. It has no assignment, status mutation,
 * polling, search, or retry behavior.
 */
export class HindsightLinearAdapter {
  constructor({ endpoint, token, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
    this.endpoint = endpoint;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(query, variables, { create = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ query, variables }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        // A failure after dispatching a mutation cannot establish whether Linear
        // created the issue. It is deliberately unknown and never retried.
        if (create) throw new HindsightWorkError("unknown_create_outcome");
        throw new HindsightWorkError("linear_request_failed");
      }
      if (!response || !response.ok) throw new HindsightWorkError("linear_http_error");
      let body;
      try {
        body = await response.json();
      } catch {
        throw new HindsightWorkError("invalid_linear_response");
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || (Array.isArray(body.errors) && body.errors.length > 0)) {
        throw new HindsightWorkError("linear_graphql_error");
      }
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async createIssue(input, configuredTeamId) {
    const data = await this.request(ISSUE_CREATE_MUTATION, { input }, { create: true });
    const result = data?.issueCreate;
    if (!result || result.success !== true) throw new HindsightWorkError("linear_create_rejected");
    return issueFromResponse(result.issue, configuredTeamId);
  }

  async resolveIssue(id, configuredTeamId) {
    const data = await this.request(ISSUE_LOOKUP_QUERY, { id });
    if (!data?.issue) throw new HindsightWorkError("linear_issue_not_found");
    const issue = issueFromResponse(data.issue, configuredTeamId);
    return issue;
  }
}

export function createRequestPreview(input) {
  return JSON.stringify({ query: ISSUE_CREATE_MUTATION, variables: { input } }, null, 2);
}

export function linkLookupRequestPreview(id) {
  return JSON.stringify({ query: ISSUE_LOOKUP_QUERY, variables: { id } }, null, 2);
}
