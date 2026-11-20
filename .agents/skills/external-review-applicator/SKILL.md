---
name: external-review-applicator
description: Guidelines and mandatory reporting directives for validating, adapting, and applying code patches from external AI reviews (e.g. REVIEW_REPORT.md, second-opinion analyses). Enforces reporting all discrepancies, false positives, and adjustments made to external instructions.
---

# External Review Applicator & Adaptation Reporter

This skill guides agents when receiving, validating, and applying code reviews, patch sets, or directives produced by another AI (e.g., `REVIEW_REPORT.md`, second-opinion analyses, or external prompt reviews).

## 1. Core Principle: Never Blindly Apply External AI Output

External AI reviews often analyze code in isolation, missing live type definitions, component prop names, database column schemas, or subtle concurrency invariants.

Before modifying any file:
1. **Validate and Assess First**: Check actual types, caller signatures, and database schemas.
2. **False Positive & Conflict Filter**:
   - Check for identifier collisions (e.g., an imported function having the same name as a component prop).
   - Check database column names against SQLite schemas in `db.rs` (e.g., `board_id` vs `pinboard_id`).
   - Check edge-case behaviors (e.g., how bounded categories and overflow trimming interact).
3. **Run Pre-Checks**: If the review specifies a reproduction step (e.g., clean checkout behavior), test it first.

---

## 2. Mandatory Reporting in Chat Responses

Whenever changes are applied based on directives from an external AI, the final report delivered to the user in chat **MUST** contain a dedicated section:

### Section Title:
`### Divergences & Adaptations from External AI Directives`

### Required Content:
1. **Corrections to Flawed Suggestions**:
   - Detail any compilation errors, type shadowing, or invalid imports in the external AI's snippets and how they were fixed.
2. **Database & Schema Fixes**:
   - Note any incorrect table, column, or query references in the external AI's test or implementation code.
3. **Logic & Invariant Adjustments**:
   - Document any architectural deviations where the external AI's suggestion would have caused a regression, data loss, or race condition.
4. **Test Adjustments**:
   - Explain any discrepancies between the external AI's expected test behavior and the real codebase requirements.
