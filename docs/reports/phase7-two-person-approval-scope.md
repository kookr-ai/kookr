# Phase 7 Two-Person Approval Scope

Issue #334 accepts a two-person permission approval flow test only when the
flow is configurable. The current Phase 4a/5/6 implementation has a single
`permissionApprove` command path guarded by relay grants and the local node
permission broker; there is no persisted relay policy or server setting that
requires two distinct approvers for a permission request.

Phase 7 therefore leaves permission execution single-decision and surfaces the
absence in the relay dashboard. The invitation and grant plumbing added in this
phase keeps `permissionApprove` as a distinct grant so a future approval-policy
configuration can require quorum without changing the grant vocabulary.
