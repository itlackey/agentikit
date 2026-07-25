# OKF format support

**Status:** DECIDED (0.9.0 target). OKF is a first-class format supported by
AKM through the built-in `okf` adapter.

“First-class” states the supported product boundary, not that every conformance
case already passes. Full conformance is claimed only when the runbook below
passes end to end.

## The decision

AKM can install, index, search, show, validate, and, where the source is
writable, author conformant OKF bundles. OKF support is held to the observable
conformance contract in the
[OKF v0.1 conformance runbook](../testing/okf-v0.1-conformance-runbook.md).

OKF is **not**:

- AKM's internal or foundational content model;
- the default adapter for an AKM workspace;
- an AKM asset type;
- a schema imposed on Claude, OpenCode, Agent Skills, workflows, tasks,
  environments, scripts, LLM Wiki bundles, or AKM-native stash files;
- the source of type or identity rules for adapters that own other formats.

Each adapter owns its native recognition, identity, metadata, links,
validation, and placement rules. The normalized `IndexDocument` is the narrow
cross-format search projection; it is not an OKF document.

## First-class support contract

For a bundle selected as `adapter: okf`, AKM must provide all of the following:

1. Every conformant non-reserved Markdown concept is recognized with its OKF
   path-minus-`.md` concept ID.
2. `type`, `title`, `description`, `tags`, and `timestamp` are read according
   to OKF rules. Unknown types and unknown frontmatter fields remain valid.
3. `index.md` and `log.md` retain their OKF structural meaning and are not
   indexed as concepts.
4. OKF links are retained as relationships. A dangling link does not prevent
   indexing.
5. A ref emitted by search for an OKF concept is accepted by show and other
   applicable ref-consuming commands. Adapter-owned concept IDs such as
   `tables/customers` must not be rejected merely because they do not use an
   AKM stash placement directory.
6. A writable OKF target uses adapter-owned placement and emits conformant OKF
   documents. If that write contract is unavailable, the source is read-only;
   AKM must not silently write AKM-native files into it.

These requirements are format support, not a universalization rule. In
particular, accepting `okfbundle//tables/customers` requires ref resolution to
honor the selected adapter and index; it does not make every AKM concept ID an
OKF concept ID.

## AKM-native behavior remains separate

The built-in `akm` adapter continues to classify AKM-native content with its
existing matcher and placement rules. Directory, extension, filename, and
content probes remain authoritative for that adapter. Frontmatter `type` does
not override those rules merely because OKF uses a field with the same name.

`akm init` creates an AKM workspace and selects the `akm` adapter. It does not
add a root `index.md` merely to make the workspace look like an OKF bundle.
Users who want an OKF bundle add or configure one as an OKF source.

Shared implementation details such as path-like refs and an open indexed
`type` field are AKM core contracts. Their use by OKF does not make them
OKF-owned semantics.

## See also

- [`akm-0.9.0-bundle-adapter-spec.md`](./akm-0.9.0-bundle-adapter-spec.md)
  defines the concrete `okf` and `akm` adapter boundaries.
- [`ref.md`](./ref.md) defines the cross-format ref grammar.
- [`0.9.0-decisions.md`](./0.9.0-decisions.md) records this positioning as D11.
