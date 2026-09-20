/** Internal declarations for the Node-only native module bridge. */
export interface NativeCredentialLock {
  openLock(path: string): unknown;
  tryLock(handle: unknown): boolean;
  closeLock(handle: unknown): void;
}
export function loadNativeCredentialLock(): NativeCredentialLock;
export function nativeCredentialLockPresent(): boolean;
