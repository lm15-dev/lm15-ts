# Credential lock identity and upgrade safety

Python, TypeScript and Rust now derive a lock filename from the same resolved
credential path, including missing files through directory aliases or dangling
symlinks. Symlinks are followed before a subsequent `..` is applied. Home
expansion preserves that ordering. Resolution fails explicitly on inaccessible,
non-directory, looping and non-Unicode paths; no guessed lock is used. At most
40 link expansions are accepted.

Windows identities remove the ordinary verbatim prefix, normalize separators
and use whole-string Unicode lowercase. This conservatively overlocks
case-sensitive Windows directories. Missing non-ASCII components and non-ASCII
UNC roots are refused rather than risking inconsistent identities. Provision
such local files first or use an ASCII missing suffix. Device names, alternate
streams, drive-relative paths and trailing-dot/space components are refused.
Ordinary POSIX hashes stay unchanged.

**Upgrade participants together.** Stop old credential-refresh/store-writing
processes before restarting them on the corrected versions, especially on
Windows and for previously unresolved POSIX aliases. Mixed versions may choose
different filenames. Use the same `LM15_LOCK_DIR`; never delete a live lock file.

This does not unify hardlinks, bind mounts or mapped-drive/UNC aliases, protect
against changing symlink namespaces, or coordinate foreign CLIs. Runtime
Unicode-data-version differences still require validation. Explicit absolute
paths avoid home-discovery differences; the shared resolver supports current-user
`~`, not named-user expansion.

The [native locking backend](credential-locking.md) must still be built and
packaged on platforms that require it. Path tests and native helper source are
provided, but no tests or native builds were run in this implementation pass.
