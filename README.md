# NuRoots

Private, family-first genealogy app hosted independently at **https://nuroots.clearteck.org**.

## Current status

- Live **illustrative interface preview** with fictional example people only.
- Adds people locally in the browser for testing usability; refresh discards changes.
- A separate Cloudflare D1 database named `nuroots` has been provisioned with no family records.
- **Not yet ready for real family data**: authentication, access authorization, write APIs, relationship editing and persistent storage must be implemented and verified before enabling real records.

## Product principles

1. Simple enough for a grandparent: legible labels, large tap targets, gentle step-by-step forms.
2. Private by default: invitation-only membership; living persons never appear in public responses.
3. Avoid incorrect genealogy: distinguish verified, remembered, inferred, and unknown details, and cite sources.
4. Prevent accidental edits: permissions, audit log, reversible changes, backups, duplicate detection.
5. Easy migration: GEDCOM import and export once validated.

## Planned stack

Cloudflare Workers, D1 relational database, R2 for restricted photo/document uploads. Cloudflare Access or equivalent verified sign-in; never trust user-supplied email headers without verified authentication.

## Development

Source for the current deployed design preview is in `src/worker.js`. The current Worker serves embedded HTML with a demo-only browser interface. Keep this source and the Cloudflare deployment synchronized. The D1 schema lives in `schema.sql`.

Do not publish any actual relatives' information in this public GitHub repository or in the public preview.

## Next milestones

- Verified family sign-in and roles (owner/editor/viewer), invitation process.
- D1-backed people and relationship CRUD, server-side validation, audit logging, and undo.
- Family tree navigation and one-question-at-a-time editing.
- Photos, captions, source citations and opt-in family stories.
- GEDCOM import/export, backups, privacy review and accessibility testing.
