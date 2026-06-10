---
name: realtime-state-sync
description: Keep realtime UI state consistent with snapshot+delta sequencing, source tagging, dedup layers, and safe reconciliation.
keywords: snapshot delta, sequence number, gap recovery, source tagging, dedup window, idempotency key, reconciliation loop, animated cards, stale event
related: websocket-dashboard, event-driven-messaging-patterns
---
# Real-Time State Synchronization
## When to Use
- Multiple event sources publish overlapping updates.
- Dashboard cards/widgets drift or flicker after reconnect.
- Duplicate events trigger duplicate UI transitions.
- Periodic refresh resets DOM and breaks animation state.

## Quick Reference
| Symptom | Root Cause | Verify | Fix |
|---|---|---|---|
| Client shows stale state after reconnect | Missing snapshot+delta catch-up | Drop/reconnect with known `last_seq` | Replay from `last_seq+1` or send new snapshot |
| Same logical event processed twice | Single-layer dedup only | Emit same entity event via 2 sources | Apply sequence dedup + idempotency-key/window fallback |
| Event provenance unclear | Unlabeled producer path | Inspect payload for origin metadata | Require normalized envelope with `source` tag |
| Active card animation restarts on refresh | Destructive reconciliation | Trigger periodic refresh during animation | Merge state non-destructively; preserve widget instance identity |

## Patterns
| Pattern | Rule | Verification |
|---|---|---|
| Normalized event envelope | Every event carries `seq`, entity identity, action, source tag, and full/current resource state | Consumers can render without source-specific parsing branches |
| Source-tagging contract | `source` is explicit (`redis`, `core_hooks`, `worker_pool`, etc.) for observability + dedup tuning | Logs and telemetry can group duplicates by source |
| Layered dedup | First by monotonic sequence, then by idempotency key/time window for cross-origin duplicates | Duplicate publish path updates UI once |
| Gap recovery | If `incoming_seq > last_seq + 1`, trigger catch-up flow immediately | Simulated dropped event restores consistent state |
| Non-destructive reconciliation | Reconcile active cards/widgets by key and patch state; do not rebuild container DOM wholesale | In-progress timers/animations continue through reconciliation |
| Outbox-backed publish | Persist state change + event intent transactionally before fanout | No dual-write drift under transient broker failure |

## Common Pitfalls
| Pitfall | Why It Fails | Safer Alternative |
|---|---|---|
| Timestamp ordering instead of sequence | Clock skew and network reordering | Monotonic sequence numbers per event stream |
| Event payload is partial diff only | Missed diff causes drift | Include full resource state in delta payload |
| One dedup key for all event types | Collides unrelated entities | Use entity-scoped identity + source-aware window |
| Refresh by replacing entire DOM subtree | Loses animation/timer state | Keyed merge/patch reconciliation |

## See Also
- [[websocket-dashboard]]
- [[event-driven-messaging-patterns]]
