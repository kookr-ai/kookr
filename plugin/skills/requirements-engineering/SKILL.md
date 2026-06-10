---
name: requirements-engineering
description: Writing precise, testable, structured requirements - SHALL/SHOULD/MAY phrasing, INVEST stories, acceptance criteria, ubiquitous language, prioritization
keywords: requirements, user stories, acceptance criteria, INVEST, MoSCoW, WSJF, Gherkin, SHALL, SHOULD, MAY, RFC 2119, functional requirements, non-functional requirements, NFR, glossary, ubiquitous language, prioritization, specification
related: mbse-system-modeling, domain-driven-design, state-machine-workflow-patterns
---

# Requirements Engineering

Rules for writing requirements that are precise, testable, and unambiguous. Prevents vague specifications that waste implementation effort.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **No subjective adjectives** | "fast", "user-friendly", "reliable" | Measurable criterion: "< 200ms p99", "WCAG 2.1 AA", "99.9% uptime" |
| 2 | **SHALL/SHOULD/MAY (RFC 2119)** | "will be sent", "should handle" | "The system SHALL deliver...", "The system SHOULD cache..." |
| 3 | **Active voice only** | "Errors are handled" | "The error handler SHALL log with stack trace" |
| 4 | **Separate functional from non-functional** | "Login shall be secure and fast" | FR: "SHALL authenticate via JWT". NFR: "SHALL complete in < 150ms p95" |
| 5 | **INVEST for every story** | "As a user I want the notification system" | Independent, Negotiable, Valuable, Estimable, Small, Testable |
| 6 | **3-5 acceptance criteria minimum** | "Handle errors, add validation" | Gherkin Given/When/Then + happy path + negative scenario |
| 7 | **Ubiquitous language enforced** | "Session", "Connection" used interchangeably | Glossary: "WebSocketConnection = persistent authenticated link identified by..." |
| 8 | **Explicit prioritization method** | Everything marked "High" | MoSCoW for MVP, WSJF for backlog, Kano for delight features |
| 9 | **Testable statement check** | "Handle errors appropriately" | If you cannot write a pass/fail test, rewrite it |
| 10 | **Priority tag on every requirement** | No priority field | Must/Should/Could/Won't on every item |

## Requirement Phrasing

### Mandatory Keywords (RFC 2119)

| Keyword | Meaning | Use When |
|---------|---------|----------|
| **SHALL** | Mandatory, must be implemented | Core functionality, security, compliance |
| **SHALL NOT** | Prohibited | Security constraints, data handling |
| **SHOULD** | Recommended, expected unless justified | Best practices, performance targets |
| **SHOULD NOT** | Discouraged | Known anti-patterns |
| **MAY** | Optional | Nice-to-have features, extensibility |

### WRONG vs CORRECT

```
WRONG: "Notifications will be sent. Errors should be handled. High priority."

CORRECT:
Functional (SHALL):
  The WebSocket handler SHALL broadcast a JSON payload
  { type: "notification", payload: {...} } to the recipient's
  socket when a new message is inserted in PostgreSQL.

Non-functional (SHALL):
  Delivery latency SHALL be < 200ms p99 at 5,000 concurrent connections.

Constraint (SHALL):
  All payloads SHALL be validated against a Zod schema before transmission.
```

## Functional vs Non-Functional Separation

Always split requirements into separate sections:

```
WRONG: "The login shall be secure and fast."

CORRECT:
Functional:
  FR-AUTH-001: The system SHALL authenticate a user with email +
  password and return a JWT stored in httpOnly cookie.

Non-functional:
  NFR-AUTH-001: Authentication SHALL complete in <= 150ms p95.
  NFR-AUTH-002: SHALL support 10,000 logins/hour.
  NFR-AUTH-003: SHALL enforce 5 attempts/min rate limit per IP.
  NFR-AUTH-004: SHALL use bcrypt with cost 12.
```

**NFR categories checklist** (verify coverage for every feature):
- Performance (latency, throughput)
- Security (auth, encryption, rate limiting)
- Scalability (concurrent users, data volume)
- Reliability (uptime, recovery time)
- Maintainability (code complexity, test coverage)
- Accessibility (WCAG level)
- Observability (logging, metrics, tracing)

## User Story Quality (INVEST)

Before accepting any story, verify all six criteria:

| Letter | Criterion | Test |
|--------|-----------|------|
| **I** | Independent | Can be implemented without other stories in the sprint |
| **N** | Negotiable | Implementation approach is flexible, not prescribed |
| **V** | Valuable | Delivers user or business value (not just technical) |
| **E** | Estimable | Team can estimate effort (not too vague or unknown) |
| **S** | Small | Fits in one sprint (if not, split) |
| **T** | Testable | Has concrete pass/fail acceptance criteria |

```
WRONG (fails I, S, T):
  "As a user I want a full real-time notification system
   so I can stay up to date."

CORRECT (passes all):
  "As a logged-in user, I want to receive a toast when someone
   mentions me in a channel, so I can react instantly."
  Acceptance criteria:
  1. Given recipient has open WebSocket, When mention published,
     Then toast appears within 200ms
  2. Given recipient is offline, When mention published,
     Then notification queued for next login
  3. Given payload > 10KB, Then toast shows "see more" link
```

## Acceptance Criteria Formats

### Gherkin (for multi-step flows)

```gherkin
Given the recipient has an open WebSocket connection
When a new mention event is published to Redis
Then the frontend receives the payload within 200ms
  And displays a dismissible toast
```

### Table (for data variations)

| Scenario | Input | Expected |
|----------|-------|----------|
| Normal | payload < 2KB | Instant toast |
| Large | payload 10KB | Toast + "see more" link |
| Offline | no WS connection | Queued for next login |
| Rate limited | > 50 toasts/min | Batch into digest |

### Minimum coverage per story
- Happy path (required)
- Main alternative flow (required)
- At least one negative/error scenario (required)
- Edge cases with data variations (when applicable)

## Ubiquitous Language

Every domain term must have one definition used everywhere:

```
WRONG: "Session", "Connection", "Channel" used interchangeably.

CORRECT (glossary entry):
  WebSocketConnection = persistent, authenticated bidirectional link
    between a Vue client and the Hono server, identified by
    Redis key "ws:conn:{userId}:{socketId}".
  Channel = logical grouping of users for pub/sub (stored in PostgreSQL).
```

**Process:**
1. Extract every domain noun/verb from input
2. Check the project glossary in the canonical requirements doc (`docs/requirements.md`) or the RFC glossary
3. If term is undefined, create definition and confirm with user
4. Enforce exact term in all requirements, code, and tests
5. Revisit glossary after every major feature

## Prioritization Methods

| Method | Use When | Formula/Approach |
|--------|----------|------------------|
| **MoSCoW** | MVP scoping | Must/Should/Could/Won't buckets |
| **WSJF** | Ongoing backlog | (Business value + Time criticality + Risk reduction) / Effort |
| **Kano** | User delight features | Must-be / One-dimensional / Attractive / Indifferent / Reverse |

**Rule:** Never default to "High/Medium/Low" without a method. Always document the scores/rationale.

```
Example WSJF:
  "Send mention toast" -> Value=8, Criticality=7, Risk=6, Effort=3
  WSJF = (8+7+6) / 3 = 7.0 -> Must-have in next sprint
```

## Common Anti-Patterns Checklist

Before writing or reviewing requirements, verify:

- [ ] No subjective adjectives without measurable criteria
- [ ] All requirements use SHALL/SHOULD/MAY correctly
- [ ] Active voice only (no "is handled", "will be processed")
- [ ] Functional and non-functional requirements are separated
- [ ] Every user story passes INVEST (all 6 criteria)
- [ ] Every story has 3+ acceptance criteria (happy, alternative, negative)
- [ ] Domain terms defined in glossary and used consistently
- [ ] Priority assigned using explicit method (not just "High")
- [ ] Every requirement is testable (can write pass/fail assertion)
- [ ] NFR categories checklist reviewed (perf, security, scale, etc.)

## See Also

[[mbse-system-modeling]] - Multi-level architecture documentation with MBSE approach
[[domain-driven-design]] - Bounded contexts, aggregates, ubiquitous language
[[state-machine-workflow-patterns]] - State machine discipline for workflow modeling
