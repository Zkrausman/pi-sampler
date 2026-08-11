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

// Linear responses only need a few identifiers/status fields. Keep a fixed
// upper bound before decoding JSON so an authenticated endpoint cannot turn a
// malformed or hostile response into unbounded local memory consumption.
export const MAX_LINEAR_RESPONSE_BYTES = 64 * 1024;

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

async function readBoundedJson(response) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_LINEAR_RESPONSE_BYTES)) {
    throw new HindsightWorkError("linear_response_too_large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new HindsightWorkError("invalid_linear_response");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new HindsightWorkError("invalid_linear_response");
      total += value.byteLength;
      if (total > MAX_LINEAR_RESPONSE_BYTES) {
        const canceled = reader.cancel?.();
        if (canceled) await canceled.catch(() => undefined);
        throw new HindsightWorkError("linear_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HindsightWorkError) throw error;
    throw new HindsightWorkError("invalid_linear_response");
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HindsightWorkError("invalid_linear_response");
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

  async request(query, variables) {
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
      } catch {
        throw new HindsightWorkError("linear_request_failed");
      }
      if (!response || !response.ok) throw new HindsightWorkError("linear_http_error");
      const body = await readBoundedJson(response);
      if (!body || typeof body !== "object" || Array.isArray(body) || (Array.isArray(body.errors) && body.errors.length > 0)) {
        throw new HindsightWorkError("linear_graphql_error");
      }
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async createIssue(input, configuredTeamId) {
    // Once a mutation is dispatched, no response condition can prove it did
    // not succeed remotely. Every post-dispatch failure is unknown and is
    // deliberately never retried by this adapter or command.
    try {
      const data = await this.request(ISSUE_CREATE_MUTATION, { input });
      const result = data?.issueCreate;
      if (!result || result.success !== true) throw new HindsightWorkError("linear_create_rejected");
      return issueFromResponse(result.issue, configuredTeamId);
    } catch {
      throw new HindsightWorkError("unknown_create_outcome");
    }
  }

  async resolveIssue(id, configuredTeamId) {
    const data = await this.request(ISSUE_LOOKUP_QUERY, { id });
    if (!data?.issue) throw new HindsightWorkError("linear_issue_not_found");
    return issueFromResponse(data.issue, configuredTeamId);
  }
}

export function createRequestPreview(input) {
  return JSON.stringify({ query: ISSUE_CREATE_MUTATION, variables: { input } }, null, 2);
}

export function linkLookupRequestPreview(id) {
  return JSON.stringify({ query: ISSUE_LOOKUP_QUERY, variables: { id } }, null, 2);
}
