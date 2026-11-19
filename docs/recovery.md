# Recovery after uncertain cleanup

An MXC supervisor can die while sandboxed work remains active. Killing a
supervisor, observing output EOF or removing a directory does not prove target
termination. The provider retains recovery information for uncertain jobs and
fails disposal when owned resources cannot be verified as released. It does not
replay the command, fall back to host execution or silently reopen the backend.

## What the records mean

Before allocation, BYOS receives an aggregate allocation descriptor with a
private generation-root path and no automatic expiry. The root contains private
job records with the job identifier, supervisor PID and, once known, the target
PID. On Linux, a record also lists any empty placeholder files that the job
created to protect absent workspace paths. Startup checks that the target is the
original process-group leader before releasing the command. An uncertain record
does not confirm that the leader check passed. Commands, caller environment and
credentials are not persisted there.

A record identifies known provider ownership. The descriptor and journal do not
close the allocation-before-acknowledgement crash window. Missing target
identity does not prove that native allocation never started. A PID alone is not
current ownership evidence, and recorded identities do not enumerate every
descendant.

Confirmed completion concerns the direct process and original supervised process
group, plus per-job provider-owned allocation release. Successful generation
disposal also removes private directories. Children in other groups or sessions
may still run with their access restrictions intact. Such children can modify
permitted workspace files even after successful disposal or session replacement.
Successful record removal does not certify their absence or revoke their access.
A zombie cannot produce further effects.

## Operator procedure

1. Stop issuing work through the quarantined generation. Preserve the BYOS error
   and recovery descriptor. Avoid unrelated writes to the affected workspace
   while assessing possible surviving processes.
2. Inspect the exact generation root and its records. Do not publish raw process
   command lines, workload output or other potentially secret data in a
   diagnostic report. The adapter's sanitised diagnostics are separate from
   workload stdout/stderr.
3. Establish current process ownership independently before any process action.
   Check current executable, ancestry, group/session information and other
   available identity evidence. A recorded numeric PID may have been reused.
   Never run a stale-PID kill recipe.
4. Resolve live original-group members and provider-owned supervisors or
   auxiliary allocations with appropriate host process-management tools. If
   ownership cannot be established, stop automation and obtain operator
   assistance. The provider does not have an automatic crash-recovery lease.
5. Assess scope-excluded descendants separately. Stop those processes too if
   continued workspace access is unacceptable. Resolving the recorded group
   alone cannot establish whole-workload absence.
6. Remove the placeholder files that a record lists once that job's processes
   have stopped, checking that each one is still an empty file. Removing a
   placeholder earlier detaches its mount inside a running sandbox, which lets a
   surviving process create the protected path.
7. Remove only the exact provider-owned generation root after owned-resource
   release has been established. Do not delete, replace or roll back the shared
   workspace. Deleting scratch or control records does not stop processes,
   revoke workspace access or release descriptors retained by excluded
   descendants.

There is no expiry time after which records can safely be discarded merely
because time passed. If an excluded descendant prevents the provider from
releasing its own handles or allocations, disposal must still fail and preserve
recovery. This is distinct from a survivor that retains only its own kernel
references.

## Evidence and platform limits

The macOS tests independently observe supervisor disappearance, original-group
termination and private-directory removal. A finite hard-supervisor-crash
fixture confirms an unknown result and retained records while the original group
continues permitted effects. Fixture recovery waits for the finite target and
verifies group exit before deleting records.

Linux namespaces, Bubblewrap helpers and networking/slirp resources need
independent release verification on an unprivileged Linux runner. That gate has
not run. The macOS evidence does not establish Linux allocation cleanup or
whole-workload termination on either platform.
