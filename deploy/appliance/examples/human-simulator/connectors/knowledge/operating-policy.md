# RESAUX operating policy (simulator)

This document is staged fixture knowledge for a synthetic RESAUX dry-van RFQ.
It is not customer data and must not be used as a production pricing policy.

- Quote only the configured `T3S3_53_DRYVAN` profile for the simulated request.
- Resolve routes through live INEGI SAKBE evidence; do not substitute an
  unverified route estimate.
- Treat the HTTP mock TMS as a SAP-contract simulator only. It is neither a
  SAP connector nor certified against a SAP tenant.
- Keep outbound quote delivery approval-required. The configured approver is
  the existing RESAUX authorized user.
- Never place credentials, receiving addresses, registration tokens, license
  files, or raw mailbox content in this fixture or its evidence bundle.
