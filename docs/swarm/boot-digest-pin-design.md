# boot-digest-pin — design (half page) + implementation (DA3)

owner f32a0507 · 2026-10-09 · 协调者派单(docker-agent 吸收批第三件,user 已批立项)· 借 OCI digest-pin 概念(非机制),参考 docs/research/docker-agent-eval.md Q3 + 立项③ · branch `feat/boot-digest-pin` off main `bdd93d7` · design + impl 一并交付

## Problem

The remote boot pulls its install script from a MUTABLE URL (`remote-bootstrap.ts` `HERDR_INSTALL_URL =
https://herdr.dev/install.sh`) and a role by name. So "same boot-template" does NOT guarantee "same member" — the source can
drift between two placements, and placement cannot prove two boots are identical. OCI's lesson (eval Q3): a `tag` (incl. implicit
`:latest`) re-resolves every run; a `@sha256:…` digest is immutable + cache-served. Borrow the CONCEPT: address boot artifacts by
content digest.

## Design

A boot is described by a **manifest** of content-addressed artifacts; the digest (sha256 hex) is immutable/reproducible, the
`sourceRef` (url/tag/branch) is kept for provenance only and is NEVER what a reproducible boot pulls by.
`BootManifest = { schema:"boot-digest-pin/v1", artifacts: { id, kind, digest, sourceRef? }[] }`,
`kind ∈ {install-script, role-profile, repo-commit, boot-template, notebook}`.

Pure core (`packages/bus/src/swarm/boot-digest-pin.ts`, no IO/clock/network):
- `computeArtifactDigest(content)` = sha256 of the bytes/text; `pinnedRef(d)` = `sha256:<hex>`; `isImmutableRef` / `digestOfRef`
  — only `sha256:<hex>` is immutable; a `latest`/tag/branch/URL is mutable (the caller must refuse it).
- `validateBootManifest` / `buildBootManifest` — trust boundary, whole-reject (dup id, unknown kind, a non-digest `digest` so a
  `latest` can never pose as a pin, bad sourceRef). build computes digests from the actual contents.
- `verifyPulledArtifact(manifest, id, pulledContent)` — the SEAM check: recompute the digest of what was actually fetched; a
  mismatch = the mutable source drifted ⇒ REJECT (never boot a non-reproducible member); an unknown id ⇒ REJECT (unpinned).
- `sameBootPin(a, b)` — reproducibility equality (same id→digest set, order-independent, sourceRef ignored) for placement.
- `bootDigestPinEnabled` (SWARM_BOOT_DIGEST_PIN, default OFF).

## Seam (documented, NOT wired — signed files untouched)

The attach point is vm-ctl's boot family, which stays UNCHANGED (coordinator: independent file, don't touch the signed
vm-ctl/placement/remote-bootstrap branches). When the flag is flipped, `remote-bootstrap.buildBootstrapScript` /
`vm-ctl up` would: (1) resolve each artifact's content, (2) `verifyPulledArtifact` the fetched bytes against the manifest pin,
(3) pull by `pinnedRef(digest)` and REFUSE any mutable ref (the `HERDR_INSTALL_URL` becomes `sourceRef` provenance; the pinned
install-script digest is what gates the boot). placement records the manifest so two boots with `sameBootPin` are provably the
same member. This module ships pure + selftested + dormant; no spawn/boot path changes here.

## What to grill (reviewer)

1. A mutable ref can never pose as a pin — `validateBootManifest` rejects a `digest` that is not a bare 64-hex sha256 (so
   `latest`/a tag/URL is refused); `isImmutableRef` accepts ONLY `sha256:<hex>` (not a bare digest, not `sha256:<hex>:latest`).
2. Drift detection is real — `verifyPulledArtifact` recomputes the digest of the ACTUAL pulled content and rejects a mismatch
   (the mutable source changed) and an unknown id (unpinned ⇒ refuse).
3. Whole-reject trust boundary — dup id / unknown kind / bad sourceRef reject the whole manifest; `buildBootManifest` rejects a
   dup id at the authoring boundary.
4. Reproducibility equality — `sameBootPin` is order-independent and ignores `sourceRef` (only content identity decides); a
   digest or count difference ⇒ false.
5. Dormant + non-invasive — `SWARM_BOOT_DIGEST_PIN` default OFF; the module is an independent file, imports nothing from and
   edits nothing in the signed vm-ctl/placement/remote-bootstrap files.

## Verification

boot-digest-pin.test.ts 8/8 · bus tsc 0 · full bus 87 files / 1155 pass. Not pushed, not merged (merge/enable gate =
coordinator + user).
