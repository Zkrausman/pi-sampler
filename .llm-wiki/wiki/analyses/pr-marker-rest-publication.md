---
type: analysis
title: Validated PR marker publication through REST
status: reviewed
category: delivery-governance
created: 2026-08-24
updated: 2026-08-25
confidence: high
slug: pr-marker-rest-publication
---

# Validated PR marker publication through REST

When a marker-only transport attempt does not change a pull-request body, fail closed and revalidate the exact body, base, and head before retrying. With explicit human authority, preserve the existing body as an exact byte prefix, validate the proposed body against the private receipt, and use a bounded GitHub REST `PATCH` to `repos/{owner}/{repo}/pulls/{number}` with only the `body` field.

After publication, fetch and compare the body byte-for-byte, require exactly one expected marker, rerun local validation, and wait for the edited-event evidence check. Candidate, receipt, or binding changes require renewed review; a transport-only retry does not.

The private receipt, fetched response, request payload, body snapshots, and validation output remain local. This procedure transports existing authority evidence; it never grants publication or merge authority.
