/* AUTH-4 kernel locks. Node-API only; no third-party library or node internals.
 * Native code owns its descriptors, avoiding Node/addon CRT fd-table mismatches.
 * See docs/credential-locking.md. Lock files are NEVER unlinked here.
 */
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <stdint.h>
#ifdef _WIN32
#include <windows.h>
typedef HANDLE lock_fd;
#define INVALID_LOCK INVALID_HANDLE_VALUE
#define CLOSE_LOCK CloseHandle
#else
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
typedef int lock_fd;
#define INVALID_LOCK (-1)
#define CLOSE_LOCK close
#endif

typedef struct { lock_fd fd; } held_lock;

static void finalize_lock(napi_env env, void *data, void *hint) {
    held_lock *lock = (held_lock *)data;
    (void)env; (void)hint;
    if (lock->fd != INVALID_LOCK) CLOSE_LOCK(lock->fd);
    free(lock);
}

static napi_value fail(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}

static held_lock *get_lock(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    void *data = NULL;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
        napi_get_value_external(env, argv[0], &data) != napi_ok || data == NULL) {
        fail(env, "credential lock requires its native handle");
        return NULL;
    }
    return (held_lock *)data;
}

static napi_value open_lock(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0;
    napi_value argv[1], external;
    lock_fd fd;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1)
        return fail(env, "credential lock requires a path");
#ifdef _WIN32
    if (napi_get_value_string_utf16(env, argv[0], NULL, 0, &length) != napi_ok)
        return fail(env, "credential lock requires a string path");
    WCHAR *name = (WCHAR *)calloc(length + 1, sizeof(WCHAR));
    if (!name) return fail(env, "credential lock allocation failed");
    if (napi_get_value_string_utf16(env, argv[0], (char16_t *)name, length + 1, &length) != napi_ok) {
        free(name); return fail(env, "credential lock path conversion failed");
    }
    fd = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    free(name);
    if (fd == INVALID_LOCK) return fail(env, "could not open native credential lock file");
    BY_HANDLE_FILE_INFORMATION attributes;
    if (!GetFileInformationByHandle(fd, &attributes) || GetFileType(fd) != FILE_TYPE_DISK ||
        (attributes.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
        CLOSE_LOCK(fd); return fail(env, "credential lock must be a regular non-reparse file");
    }
#else
    if (napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok)
        return fail(env, "credential lock requires a string path");
    char *name = (char *)calloc(length + 1, 1);
    if (!name) return fail(env, "credential lock allocation failed");
    if (napi_get_value_string_utf8(env, argv[0], name, length + 1, &length) != napi_ok) {
        free(name); return fail(env, "credential lock path conversion failed");
    }
    fd = open(name, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    free(name);
    if (fd == INVALID_LOCK) return fail(env, "could not open native credential lock file");
    struct stat attributes;
    if (fstat(fd, &attributes) != 0 || !S_ISREG(attributes.st_mode)) {
        CLOSE_LOCK(fd); return fail(env, "credential lock must be a regular file");
    }
#endif
    held_lock *lock = (held_lock *)malloc(sizeof(held_lock));
    if (!lock) { CLOSE_LOCK(fd); return fail(env, "credential lock allocation failed"); }
    lock->fd = fd;
    if (napi_create_external(env, lock, finalize_lock, NULL, &external) != napi_ok) {
        finalize_lock(env, lock, NULL); return NULL;
    }
    return external;
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
    held_lock *lock = get_lock(env, info);
    napi_value result;
    int acquired = 0;
    if (!lock) return NULL;
    if (lock->fd == INVALID_LOCK) return fail(env, "credential lock handle is closed");
#ifdef _WIN32
    /* Byte zero overlaps Python msvcrt.locking(..., 1) and Rust's whole-file
     * LockFileEx region, provided all ports selected the SAME lock path.
     */
    OVERLAPPED overlapped = {0};
    if (LockFileEx(lock->fd, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                   0, 1, 0, &overlapped)) acquired = 1;
    else if (GetLastError() != ERROR_LOCK_VIOLATION)
        return fail(env, "credential LockFileEx failed (not contention)");
#else
    int status;
    do { status = flock(lock->fd, LOCK_EX | LOCK_NB); } while (status < 0 && errno == EINTR);
    if (status == 0) acquired = 1;
    else if (errno != EWOULDBLOCK && errno != EAGAIN)
        return fail(env, "credential flock failed (not contention)");
#endif
    if (napi_get_boolean(env, acquired, &result) != napi_ok) return NULL;
    return result;
}

static napi_value close_lock(napi_env env, napi_callback_info info) {
    held_lock *lock = get_lock(env, info);
    napi_value result;
    if (!lock) return NULL;
    if (lock->fd != INVALID_LOCK) {
        CLOSE_LOCK(lock->fd);
        lock->fd = INVALID_LOCK;
    }
    if (napi_get_undefined(env, &result) != napi_ok) return NULL;
    return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"openLock", NULL, open_lock, NULL, NULL, NULL, napi_default, NULL},
        {"tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL},
        {"closeLock", NULL, close_lock, NULL, NULL, NULL, napi_default, NULL}
    };
    if (napi_define_properties(env, exports, 3, properties) != napi_ok) return NULL;
    return exports;
}
NAPI_MODULE(credential_lock, initialize)
