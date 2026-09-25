# Stored credential locking (Node)

AUTH-3/4/6/8 require a **kernel lock**, not a lockfile lease. `withFileLock`
keeps the lock throughout the callback (including the network refresh), and
releases it on return, throw, or process death. A persistent `.lock` file is
normal. Never delete it to resolve contention: that can create two independent
locks on different inodes. No PID check, stale-age check, or lease stealing is
used. Locks are not re-entrant.

## Backends and current delivery status

| Host | Default backend | Prerequisite |
| --- | --- | --- |
| Linux | util-linux `flock` on Node's inherited open description | `flock` on `PATH` |
| macOS | Native Node-API addon calling `flock(LOCK_EX | LOCK_NB)` | Build/package the matching `.node` below |
| Windows | Native Node-API addon calling nonblocking exclusive `LockFileEx` over byte zero | Build/package the matching `.node` below |
| Other Unix | Same native source where `flock`, `O_NOFOLLOW`, `O_CLOEXEC` exist | Host-specific build and validation; not a tested support claim |
| Browser / hosts without these primitives | No backend | Explicit credentials or an application `Platform` |

**This change includes native source, not prebuilt native binaries.** Until a
matching addon is installed, stored refresh/write on macOS and Windows fails
with `NotConfiguredError`; this is not out-of-the-box portable support. The
new source and tests have not been compiled or executed in this implementation
pass. Release engineering must build and validate each advertised host/arch.

Linux preserves the established util-linux backend and shared Python/Rust
primitive. `LM15_NATIVE_LOCK_PATH=/absolute/path/to/credential_lock.node`
selects an explicitly installed native addon on any host, including Linux.
An invalid override is an error, **not** permission to fall back. The override
is trusted executable configuration (like `PATH`); never derive it from input.
There is no runtime compiler, download, optional npm dependency, or install hook.

Native default lookup is package-relative:

```
native/credential_lock-<process.platform>-<process.arch>.node
```

Examples: `credential_lock-darwin-arm64.node`,
`credential_lock-darwin-x64.node`, `credential_lock-win32-x64.node`,
`credential_lock-win32-arm64.node`. The CommonJS bridge resolves the package's
own `@lm15/lm15/package.json` export, not the application's working directory.
Bundlers must retain this Node-only bridge and binary asset or use an explicit
absolute override. The browser entry must never import them.

A missing/wrong-architecture/incompatible addon, unsupported kernel operation,
or open failure fails closed before the critical-section callback. Contention
alone is retried at 50 ms intervals, with the existing default 60-second wait;
expiry raises retryable `LockTimeoutError` carrying `path` and `lockPath`.
`timeoutMs: 0` makes one nonblocking attempt. Timeout values must be finite and
nonnegative. Linux subprocess startup may exceed the requested contention
budget; each flock child retains its existing five-second startup ceiling.

Fresh stored credentials remain readable without any locking backend. Only
refreshes and mutations need locking. The doctor reports the configured
backend and whether the native file is present, but **does not load native
code, run a process, or promise loadability**. A selected refreshable login is
not silently replaced by an environment key when its backend is missing.

## Building and packaging (maintainers)

`native/credential_lock.c` uses public Node-API version 8 and OS APIs only.
Use official Node headers appropriate for the supported Node installation and
an ordinary platform C compiler. Node >=22 is already the package floor.
Node-API avoids a per-Node-major C++ ABI matrix; platform, CPU architecture,
minimum OS deployment target, and (on Linux) libc compatibility still matter.
Build with a suitable minimum deployment target rather than assuming binaries
built on a newer OS will run on older releases.

Illustrative manual commands (not run in this pass):

```sh
# macOS; NODE_INCLUDE contains node_api.h and the other Node headers.
# Choose x64 or arm64 to match the compiler target, not the terminal alone.
cc -std=c11 -O2 -bundle -undefined dynamic_lookup -I "$NODE_INCLUDE" \
  native/credential_lock.c -o native/credential_lock-darwin-arm64.node

# Optional Linux native backend; otherwise util-linux flock is sufficient.
cc -std=c11 -D_GNU_SOURCE -O2 -shared -fPIC -I "$NODE_INCLUDE" \
  native/credential_lock.c -o native/credential_lock-linux-x64.node
```

Windows, from a matching-architecture Visual Studio developer prompt, with
Node headers and the matching Node distribution's `node.lib` import library:

```bat
cl /LD /MD /std:c11 /O2 /I "%NODE_INCLUDE%" native\credential_lock.c "%NODE_LIB%" /link /OUT:native\credential_lock-win32-x64.node
```

These are build recipes, **not validated commands or evidence of a working
Windows/macOS artifact**. No compiler runs during import or package installation.
The addon owns its native handles itself, avoiding CRT descriptor-table
assumptions between Node and a Windows addon. Explicit close releases the handle;
a Node-API finalizer is a backup, not the normal lock-release mechanism.

Required npm build/package integration:

1. Copy `src/auth/native_lock.cjs` to **both** `dist/auth/native_lock.cjs`
   and `dist/cjs/auth/native_lock.cjs` after TypeScript emit. TypeScript does
   not copy this asset under the current configuration. Without it even the
   Linux Node entry cannot import `stores.js`.
2. Include `native` in the package `files` allowlist, retaining the C source
   and any supported prebuilt `credential_lock-*.node` artifacts. Building
   TypeScript alone does not create those artifacts. The declarations in
   `src/auth/native_lock.d.cts` are internal input; public declarations do
   not expose native handles.
3. Do not export the native bridge/binding publicly or add it to the browser
   graph. No new public package export is required.
4. Release CI must build/test each native platform/architecture actually
   advertised. Source-only releases must retain the missing-addon warning.

## Interoperability and boundaries

The name remains `$LM15_LOCK_DIR/<sha256(canonical-path)[:32]>.lock` (otherwise
AUTH-8's XDG cache/home defaults). Ordinary Linux names and primitives are
unchanged. Missing targets resolve existing ancestors and dangling symlinks.
Old `.node.lock`-using processes must be stopped before upgrading.

On POSIX the native addon and util-linux use `flock`, not POSIX `fcntl` record
locks: Python's `fcntl.flock` and Rust's `File::try_lock` contend on the same
inode. On Windows locking byte zero overlaps Python's `msvcrt.locking(..., 1)`
and Rust's whole-file `LockFileEx` region **when they open the same lock path**.
No primitive interoperability can compensate for different path hashes.

The coordinated Python/Rust/Node [path-identity repair](credential-lock-identity.md)
resolves missing targets and aliases consistently and normalizes Windows
prefix/case spelling. It is implemented but not platform-tested. **Stop old
and new Windows writers from overlapping during upgrade:** normalized identities
change old filenames. Previously unresolved POSIX aliases also require a
coordinated restart. Unsupported ambiguous Windows names fail closed; see the
linked support boundaries rather than assuming every filesystem alias is covered.

Lock directories must be owned/trusted by the current user. POSIX files are
created mode 0600; directories mode 0700. Native POSIX opens refuse a final
symlink. Native Windows opens refuse a final reparse point or non-disk file,
but ancestor reparse points and ACLs remain the application's trust boundary;
POSIX modes do not create Windows ACLs. Hardlink aliases to credentials are
not unified by path hashing. Foreign CLIs do not cooperate, and network
filesystems may not provide the local kernel semantics assumed here.

Atomic credential writes retain the existing temp-0600 → fsync → rename
sequence. File/parent fsync and permissions have the existing OS limitations;
this lock backend is not a new Windows ACL or durability implementation.

## Regression sources (not run)

`tests/lock_portable.test.ts` covers fail-closed native setup, fresh reads,
timeout validation, exclusion, persistent inodes, callback failure cleanup,
concurrent store mutations, process death, POSIX directory aliases, and optional
Python exclusion in both directions. macOS/Windows kernel tests do not skip
merely because the addon is absent: their CI jobs must install it first.
Set `LM15_LOCK_TEST_PYTHON` to a Python executable to enable the cross-language
case. Linux's existing `tests/lock.test.ts` remains intact. Native Linux can
also exercise the new source via the absolute override; do not run the old
"missing flock" case under that override, because its prerequisite is the
util-linux backend.
