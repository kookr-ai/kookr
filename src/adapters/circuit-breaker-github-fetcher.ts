/**
 * GitHubFetcher wrapper that routes fetch calls through a circuit breaker.
 * When the breaker is open, fetch calls return null (same as CLI failure).
 */
import type {
  GitHubFetcher,
  GitHubFetchBatchResult,
  GitHubReference,
  GitHubPRState,
  GitHubIssueState,
} from '../core/github-types.js';
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../core/circuit-breaker.js';

export class CircuitBreakerGitHubFetcher implements GitHubFetcher {
  constructor(
    private readonly inner: GitHubFetcher,
    private readonly breaker: CircuitBreaker,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async inferOwnerRepo(cwd: string): Promise<{ owner: string; repo: string } | null> {
    return this.inner.inferOwnerRepo(cwd);
  }

  async fetchPRState(ref: GitHubReference): Promise<GitHubPRState | null> {
    try {
      return await this.breaker.call(() => this.inner.fetchPRState(ref));
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        console.warn(`[github] Circuit breaker open — skipping PR fetch for ${ref.owner}/${ref.repo}#${ref.number}`);
      }
      return null;
    }
  }

  async fetchStates(refs: GitHubReference[]): Promise<GitHubFetchBatchResult> {
    const fetchStates = this.inner.fetchStates;
    if (!fetchStates) {
      const prs: GitHubPRState[] = [];
      const issues: GitHubIssueState[] = [];
      for (const ref of refs) {
        if (ref.type === 'pr') {
          const state = await this.fetchPRState(ref);
          if (state) prs.push(state);
        } else {
          const state = await this.fetchIssueState(ref);
          if (state) issues.push(state);
        }
      }
      return { prs, issues };
    }

    try {
      return await this.breaker.call(() => fetchStates.call(this.inner, refs));
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        console.warn(`[github] Circuit breaker open — skipping batched fetch for ${refs.length} references`);
      }
      return { prs: [], issues: [] };
    }
  }

  async fetchIssueState(ref: GitHubReference): Promise<GitHubIssueState | null> {
    try {
      return await this.breaker.call(() => this.inner.fetchIssueState(ref));
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        console.warn(`[github] Circuit breaker open — skipping issue fetch for ${ref.owner}/${ref.repo}#${ref.number}`);
      }
      return null;
    }
  }
}
