---
name: event-driven-messaging-patterns
description: Build reliable event pipelines with reconnect-safe subscriptions, idempotency, and contract fidelity.
keywords: event driven, outbox, idempotency, redis reconnect, resubscribe, field fidelity, source attribution, dead letter queue, migration cleanup
related: realtime-state-sync, websocket-dashboard
---
# Event-Driven Messaging Patterns
## When to Use
- Events stop flowing after Redis reconnect.
- UI messages lose fields (`name`, `reason`, counts).
- Legacy transport migration leaves stale realtime references.
- Duplicate or reordered side effects appear in consumers.

## Quick Reference
| Symptom | Cause | Verify | Fix |
|---|---|---|---|
| Pub/sub quiet after reconnect | Subscription not restored | Simulate Redis reconnect | Re-subscribe on reconnect-ready hook |
| UI text degraded | Bridge dropped payload fields | Compare source event vs emitted frame | Enforce field-fidelity contract tests |
| Duplicate actions | Missing idempotency key handling | Replay same message | Consumer dedup + side-effect guard |
| Migration regressions | Deprecated transport paths still active | grep code/docs/tests/config | Complete cleanup checklist below |

## Patterns
| Pattern | Rule | Checkpoint |
|---|---|---|
| Reconnect-safe subscription | On client reconnect-ready, explicitly subscribe all channels again | Channel count restored after reconnect test |
| Field fidelity | Bridge mappings are additive-only; no dropping/renaming without versioning | Contract test compares required fields end-to-end |
| Source attribution | Every emitted event includes normalized `source` and `transport` metadata | Debug traces can identify origin path |
| Outbox discipline | Publish from outbox/transaction boundary, not ad-hoc post-commit fire-and-forget | No lost events on partial failures |
| Idempotent consumers | Consumer side-effects guarded by stable idempotency key | Replay does not duplicate writes |

## Field-Fidelity Contract
| Category | Required Fields |
|---|---|
| Identity | `event_type`, `event_id`, `occurred_at` |
| Context | `workflow_id`/`task_id` when applicable |
| Human-facing | `name`, `reason`, `counts` (if source has them) |
| Routing | `source`, `transport`, `version` |

## Migration Cleanup Checklist (Legacy Bridge -> WebSocket)
| Area | Required Action |
|---|---|
| Runtime code | Remove deprecated transport handlers, feature flags, and fallback branches |
| Tests | Replace legacy transport assertions with snapshot/delta WebSocket assertions |
| Docs/runbooks | Remove deprecated transport setup and troubleshooting steps |
| Config | Delete deprecated transport env keys, ports, and health probes no longer used |
| Monitoring | Retire deprecated transport dashboards/alerts; add WebSocket reconnect + gap recovery signals |

## Common Pitfalls
| Pitfall | Why It Fails | Safer Alternative |
|---|---|---|
| Assuming Redis subscriptions persist forever | v4 reconnect clears active subscriptions | Always re-subscribe on reconnect-ready |
| Mapping event payload by manual ad-hoc picks | Fields silently lost | Central mapping schema + contract tests |
| Keeping deprecated transport “just in case” | Drift, duplicate paths, stale docs | Time-boxed migration and explicit removal PR |

## See Also
- [[realtime-state-sync]]
- [[websocket-dashboard]]
