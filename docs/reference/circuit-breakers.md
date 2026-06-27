# Circuit Breakers

Kookr uses circuit breakers to isolate failing integrations from the rest of
the supervisor. A breaker tracks recent failures for one dependency, rejects or
skips work while that dependency is unhealthy, then probes recovery after a
cooldown.

This page describes the operator-facing behavior exposed by the dashboard,
`GET /api/circuit-breakers`, and the `circuitBreakerStatus` WebSocket message.

## State Machine

Each breaker starts in `closed`.

| State | Meaning | What happens next |
| --- | --- | --- |
| `closed` | Normal operation. Calls pass through and failures are counted in a sliding window. | If the failure count reaches the configured threshold inside the window, the breaker transitions to `open`. |
| `open` | The dependency is considered unhealthy. Protected calls are rejected or skipped immediately. | A timer moves the breaker to `half-open` after the configured cooldown. |
| `half-open` | Recovery probe mode. Calls are allowed so the dependency can prove it is healthy again. | Any failure reopens the breaker. Two consecutive successes close it, unless the breaker is configured otherwise. |

When a breaker closes, its failure history and half-open success counter are
cleared. Manual rearm also closes the breaker immediately.

## Registered Breakers

The current server bootstrap registers these breakers:

| Name | Protected path | Failure threshold | Failure window | Cooldown |
| --- | --- | ---: | ---: | ---: |
| `llm` | Wraps the configured `LlmClient` via `CircuitBreakerLlmClient`. Provider failures count against the breaker. When the breaker is open, LLM completion returns `null` with an audit failure instead of calling the provider. | 5 failures | 60s | 30s |
| `github` | Wraps the GitHub fetcher via `CircuitBreakerGitHubFetcher`. Failed PR, issue, or batch fetches count against the breaker. When open, PR/issue fetches return `null`, and batch fetches return empty `prs` and `issues` arrays. | 5 failures | 60s | 60s |
| `permission-alert` | Isolates the optional permission-block alert callback used by remote integrations. Callback exceptions count against the breaker. When open, the callback is skipped and event processing continues. | 3 failures | 60s | 30s |
| `hook-watcher` | Registered for hook-watcher resilience state. As of the current implementation, no production hook-watcher path records failures against this breaker, so it should normally remain `closed`. | 10 failures | 60s | 30s |

The generic default is 5 failures in 60 seconds, 30 seconds of cooldown, and 2
half-open successes to close. The rows above list the explicit runtime
configuration from server bootstrap.

## Dashboard Panel

The dashboard renders breaker snapshots in `CircuitBreakerPanel` inside the
Diagnostics operations surface.

Use the panel as follows:

- The section summary says `all healthy` when every breaker is `closed`.
- The summary changes to `<n> tripped` when any breaker is not `closed`.
- Each row shows the breaker name, state label, recent failure count when
  non-zero, and the last failure age when available.
- An `open` breaker shows a countdown until the automatic half-open probe.
- The `Rearm` button appears only for non-closed breakers.

The panel is a live view of server snapshots. It receives the initial breaker
list when a WebSocket connection opens and receives updates when a registered
breaker changes state.

## API And WebSocket

`GET /api/circuit-breakers` returns the current registry snapshots:

```json
[
  {
    "name": "llm",
    "state": "closed",
    "failureCount": 0,
    "successCount": 0,
    "lastFailureTime": null,
    "lastStateChange": 1710000000000,
    "resetTimeoutMs": 30000
  }
]
```

The same snapshot shape is used in the server-to-client WebSocket message:

```json
{
  "type": "circuitBreakerStatus",
  "breakers": []
}
```

The server sends `circuitBreakerStatus` on WebSocket connect when breakers are
registered, and broadcasts a fresh full breaker list whenever any registered
breaker changes state.

## Manual Rearm

Manual rearm is an operator override for cases where you know the dependency has
recovered and you do not want to wait for the cooldown timer.

From the dashboard, click `Rearm` on a non-closed breaker. Programmatically,
send this client WebSocket message:

```json
{
  "type": "rearmCircuitBreaker",
  "name": "github"
}
```

The server looks up the named breaker and closes it. Unknown names are ignored.
If the underlying dependency is still failing, new failures will be counted from
scratch and the breaker can open again.

Do not use manual rearm as a permanent fix. Check the dependency first: provider
credentials, network access, `gh` availability/authentication, and any remote
integration callback logs are better signals than repeatedly rearming a breaker
that trips again.
