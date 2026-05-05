/**
 * GitHubFetcher wrapper that routes fetch calls through a circuit breaker.
 * When the breaker is open, fetch calls return null (same as CLI failure).
 */
import type { GitHubFetcher, GitHubReference, GitHubPRState, GitHubIssueState } from '../core/github-types.js';
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
