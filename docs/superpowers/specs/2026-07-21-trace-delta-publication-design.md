# TRACE delta publication design

## Context and production evidence

The TRACE evaluation worker safely computes and persists scores, but its first
100-result publication exposed a production-scale memory failure. The deployed
catalog contains 77,823 mirrored SkillHub entries. Their stored summary JSON is
about 65 MiB, while decoding the OSS index and then decoding the same full set
again through `SkillHubImportStore.mirroredEntries()` creates several expanded
object graphs, maps, sorted arrays, and JSON strings.

During the publication attempt the evaluation service grew to approximately
1.4 GiB under its 1.5 GiB cgroup limit, began swapping, exceeded the worker's
50-second budget, and raised observed IO wait to 22%. The durable catalog job
never received a target revision, proving the attempt stopped before pointer
publication. The evaluation rows remain completed and unpublished, so no score
data was lost and the existing catalog pointer remains valid.

Production is currently protected as follows:

- the new API and Web releases remain active and healthy;
- the evaluation timer is disabled;
- the general publisher timer is paused so it cannot claim the released,
  target-less catalog rebuild job;
- SkillHub mirroring and the other previously active maintenance timers remain
  independent;
- the sample `ai-intelligence-investigator` has a durable TRACE score of `4.45`
  but is not public until a safe catalog publication succeeds.

## Goals

1. Publish at most 100 completed TRACE results without reading or decoding all
   mirrored SkillHub rows from SQLite.
2. Preserve every unrelated catalog summary, detail reference, source status,
   alias, featured flag, and immutable package object.
3. Keep the existing catalog lease, import deferral, optimistic score fencing,
   pointer atomicity, retryability, and restart recovery guarantees.
4. Keep a production publication below a 1 GiB hard limit and avoid sustained
   swap or disk saturation on the current host.
5. Make the worker externally bounded even when synchronous catalog work does
   not observe an application-level abort quickly enough.

## Non-goals

- Changing the public catalog schema or clients.
- Sharding the catalog or introducing a new serving topology.
- Moving the service to another host as a substitute for fixing the algorithm.
- Rebuilding all mirrored SkillHub rows during an evaluation-only publication.

## Considered approaches

### A. Patch the current OSS index with the evaluated batch (selected)

Load the current catalog index once, validate only the selected completed
evaluation rows again under the catalog lease, replace those entries, and
publish a new immutable index plus changed details. This removes the second
77,823-row decode and preserves the existing atomic pointer design.

### B. Increase memory or move the timer to a larger host

This leaves the O(n) duplicate decode and synchronous deadline failure intact.
It delays the incident rather than correcting it and is rejected.

### C. Introduce a sharded catalog

Sharding is the best long-term option for much larger catalogs, but it changes
the storage schema, server loader, Web client, cache behavior, and deployment
rollback contract. It is intentionally deferred.

## Architecture

Add an evaluation-specific publisher operation rather than routing evaluation
batches through the full mirror publication operation. The full SkillHub mirror
continues using `mirroredEntries()` because it must reconcile the entire source.
The evaluation operation must never call it.

The delta operation consumes the existing
`completedEvaluations(limit)` interface and follows this sequence:

1. Read at most the configured batch of completed, unpublished evaluations.
2. Load and materialize only those old detail objects, forcing public `score` to
   `0` and adding `evaluationScore` plus all five TRACE dimensions.
3. Acquire the existing durable catalog lease. Import transitions discovered
   while the lease is active continue to enter the durable deferred-import
   table.
4. Re-read at most the same batch of completed evaluations while holding the
   lease. Retain a materialized result only when slug, checked time, and previous
   detail hash still match. This is the score publication fence.
5. Load the latest OSS catalog index once. Copy its entries without decoding all
   SQLite mirror summaries, replace only the retained SkillHub entries, update
   SkillHub source status from current progress, and create the next immutable
   index.
6. Upload changed detail objects, the catalog object, and facets, then persist
   the target revision and atomically move `current.json` using the existing
   publisher sequence.
7. After pointer success, CAS-update only the retained import rows with their new
   detail key/hash and publication marker.

An import change after step 3 is deferred by the existing cross-process catalog
lease. A score refresh after step 4 is rejected by the final checked-time/hash
CAS and remains eligible for the next batch.

## Failure and recovery

- Before a target revision exists, an evaluation delta failure must retire its
  transient catalog-lock job instead of leaving a generic pending full rebuild.
  Completed evaluation rows remain the durable retry source.
- After a target revision is persisted but before pointer outcome is known, keep
  the current running lease. Expiry recovery compares the pointer and either
  finalizes or safely retries.
- After pointer success but before DB markers are updated, the same completed
  evaluations remain selectable. Re-publishing the content-addressed objects and
  identical patched index is idempotent.
- A cancelled or timed-out operation must not mutate publication markers after
  returning.
- The existing incident job with no target revision will be explicitly marked
  failed during deployment after a verified database backup; it must not be
  claimed as a generic rebuild.

## Resource controls

The evaluation service will use:

- `MemoryHigh=896M` to leave the measured catalog serialization working set below
  the reclaim threshold while retaining headroom before the hard limit;
- `MemoryMax=1024M` as a hard ceiling;
- `TimeoutStartSec=65s` for the 50-second application budget plus cancellation;
- `TimeoutStopSec=10s` so systemd can terminate a process that is stuck in
  synchronous work;
- the existing dedicated non-blocking flock and one-minute persistent timer.

Application-level deadline and AbortSignal handling remain in place. Systemd is
defense in depth, not the normal cancellation mechanism.

## Tests

1. Evaluation publication succeeds when `mirroredEntries()` throws, proving the
   full SQLite mirror path is not called.
2. A current catalog with unrelated SkillHub/community/enterprise entries keeps
   those summaries and refs byte-equivalent while only evaluated entries change.
3. Revalidation under the lease rejects stale checked times and old detail
   hashes.
4. Import mutation at pointer time is deferred and applied after lease release.
5. Pre-target failure leaves no claimable generic catalog rebuild job and the
   completed evaluations remain retryable.
6. Pointer-ambiguous abort retains the lease for expiry recovery.
7. A subprocess fixture with 80,000 compact catalog entries and a 100-result
   batch must complete inside the service time budget with peak RSS below the
   1 GiB production hard limit. The test records peak RSS and fails on timeout.
8. Systemd tests assert the new memory and timeout limits.
9. Existing publisher, import fencing, worker deadline, migration, full server,
   and Web suites remain green.

## Deployment and verification

1. Build and review a new immutable API release; Web does not need another
   content change for this fix.
2. Keep evaluation and general publisher timers stopped during deployment.
3. Back up the database and confirm integrity before mutation.
4. Switch the API release and mark only the known target-less incident catalog
   job failed.
5. Run one evaluation service manually while sampling cgroup memory, swap, IO
   wait, elapsed time, and journal counts.
6. Require: service success within 65 seconds, peak memory below 1 GiB, no
   sustained swap growth, low IO wait, and no pending/running target-less
   catalog job.
7. Verify the sample API exposes `score: 0`, `evaluationScore: 4.45`, and the five
   TRACE dimensions; verify the Web page renders `4.5/5` and never `100000.0`.
8. Re-enable the general publisher timer, then the evaluation timer, and observe
   at least two timer runs before declaring the deployment healthy.

Rollback switches the API symlink to the prior release and keeps evaluation
disabled. The catalog pointer is immutable/atomic, so a failed delta attempt
does not require deleting uploaded objects.
