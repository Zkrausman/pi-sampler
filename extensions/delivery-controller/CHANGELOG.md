# @zkrausman/pi-delivery-controller

## 0.2.0

### Minor Changes

- c5d3e5a: Add a local human/host-only reference adapter that records authoritative ticket lifecycle transitions and correlates ticket-cost segments into durable ticket lifecycle receipts.

### Patch Changes

- Updated dependencies [c5d3e5a]
- Updated dependencies [45687bb]
  - @zkrausman/pi-ticket-lifecycle@0.2.0
  - @zkrausman/pi-ticket-cost@0.2.3

## 0.2.0

### Minor Changes

- Add the human/host-only local ticket lifecycle reference adapter. It uses a pre-existing work-item manifest, opaque handles, durable intent replay, recomputed local operator-attestation digests, exact in-process ticket-cost correlation, and explicit partial coverage for failed or interrupted cost segments.

## 0.1.0

### Minor Changes

- fcbb345: Publish the initial independently versioned Pi extension packages.
