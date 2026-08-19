# Registry network boundary

All HTTP(S) traffic used to discover or install registry content passes through
`src/registry/network.ts`. The boundary applies URL policy before every request,
resolves and checks every A/AAAA answer, uses manual redirects, and repeats the
same checks for every redirect hop. Cross-origin redirects drop
`Authorization`, `Cookie`, and `Proxy-Authorization` headers.

## Request inventory

| Caller | Remote input | Policy |
| --- | --- | --- |
| `src/registry/providers/static-index.ts` | Configured static index | Public HTTP(S) only |
| `src/registry/providers/skills-sh.ts` | Configured API base plus `/api/search` | Public HTTP(S) only |
| `src/setup/registry-stash-loader.ts` | Setup registry index | Public HTTP(S) only |
| `src/registry/resolve.ts` | npm package metadata | Public npm registry, or the explicit `AKM_NPM_REGISTRY` compatibility policy below |
| `src/registry/resolve.ts` | GitHub commit, release, repository, and default-branch metadata | Fixed `https://api.github.com`; redirects rejected |
| `src/sources/providers/provider-utils.ts` via `npm.ts` | npm tarball selected by registry metadata | Trusted npm host plus the npm network policy; redirects revalidated |

There are no other direct `fetch` or `fetchWithRetry` calls under
`src/registry/**`. An architecture test inventories that tree and the two
registry consumers outside it, so a new request cannot silently bypass the
boundary.

Git and GitHub bundle materialization uses the `git` executable rather than the
Fetch API. GitHub shorthand is converted to the fixed `github.com` service;
operator-supplied `git+...` locators are validated for allowed transport
schemes. Those child-process transports are not registry HTTP requests and are
outside this Fetch boundary.

## Destination policy

Normal registry discovery rejects loopback, RFC 1918/ULA private, link-local,
cloud-metadata, documentation, benchmark, multicast, reserved, and
unparseable addresses. A hostname is rejected if any resolved A or AAAA answer
is non-public. URL userinfo is rejected on the initial request and on every
redirect target.

The fixed GitHub policy only permits `https://api.github.com` and rejects all
redirects. This prevents a GitHub token from moving to another origin.

`AKM_NPM_REGISTRY` is the sole private-network compatibility exception. Setting
it explicitly permits private or loopback answers only for that configured npm
mirror's origin (and its trusted tarball host). It never permits link-local,
metadata, or reserved destinations. Redirects to another private origin are
rejected; redirects to a public CDN are allowed after DNS validation, with
sensitive headers removed when the origin changes. The default npm registry
does not receive this exception.

Static-index, skills.sh, and setup registry URLs have no private-network opt-out
in 0.9.2. Existing local or intranet registry deployments must move the index
or API to a publicly routable HTTPS endpoint. Alternatively, install a known
bundle directly through an explicit filesystem, git, GitHub, or npm source;
registry discovery is not required for direct installation.

Credential-bearing URL behavior remains the separate issue #811 policy: URLs
with embedded credentials are rejected, not translated into headers.

## Exact DNS guarantee and residual risk

AKM performs a pre-connect DNS lookup, rejects the request if any answer is
non-public, and repeats that lookup before every redirect hop. Retries stay
inside the same manually redirected request, so they cannot opt back into the
runtime's automatic redirect following.

Bun's Fetch API does not expose a pinned DNS lookup or socket hook. The final
network connection therefore resolves the hostname independently. A hostile
resolver could return a public address to AKM's check and a private address to
the immediately following connection. This time-of-check/time-of-use DNS
rebinding residual is not claimed as closed. Fully closing it requires a
transport that connects to the validated address while preserving TLS SNI and
the HTTP Host header.
