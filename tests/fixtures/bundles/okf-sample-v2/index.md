---
okf_version: "0.2"
---

# Sample OKF v0.2 Bundle

A small, conformant Open Knowledge Format **v0.2** bundle used as a fixture for
the `okf` adapter's v0.2 trust/provenance/lifecycle family parsing. This
reserved `index.md` declares the bundle's `okf_version` and is a
progressive-disclosure listing, never indexed as a concept.

## Reports

* [Quarterly Report](/reports/quarterly.md) - `generated`/`verified` (list form) + object-list `sources`.
* [Draft Note](/reports/draft-note.md) - `generated` + `verified` single-mapping form + `status: draft`.
* [Legacy Note](/reports/legacy.md) - v0.1-style `timestamp` only (no `generated`), proving the fallback still works in a v0.2 bundle.
