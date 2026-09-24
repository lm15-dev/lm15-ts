//! TLS in the page. rustls (ring provider, webpki-roots trust anchors) driven
//! over linear memory, sans I/O: the page feeds the bytes that arrive from the
//! tunnel and takes the bytes to send to it. The relay in between carries only
//! TLS records; the certificate is verified here, against the host the page
//! asked for, so a relay cannot impersonate the provider.
//!
//! ABI (all integers are u32 unless stated; a negative i32 is an error, whose
//! text `last_error` returns):
//!   alloc(len) -> ptr, dealloc(ptr, len)
//!   conn_new(host_ptr, host_len) -> handle (0 = error)
//!   conn_push_plain(h, ptr, len) -> i32   queue application bytes
//!   conn_push_tls(h, ptr, len) -> i32     feed received TLS bytes
//!   conn_pull_tls(h) -> i32               stage bytes to send; then out_ptr/out_len
//!   conn_pull_plain(h) -> i32             stage decrypted bytes; -2 = peer closed cleanly
//!   conn_handshaking(h) -> u32, conn_close(h) (queues close_notify), conn_free(h)
//!
//! rustls runs in its unbuffered, no-std mode: wasm32-unknown-unknown has no
//! clock, so the buffered std API does not build; this one takes the page's.
//! Session resumption is off (no std session cache): a fresh handshake each time.
//!   out_ptr() -> ptr, last_error() -> len (text at out_ptr)
//!
//! Imports from the page (module "env"): `now_ms() -> f64` (Date.now) and
//! `random(ptr, len)` (crypto.getRandomValues).

#![no_std]
extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::sync::Arc;
use alloc::vec;
use alloc::vec::Vec;
use core::cell::RefCell;

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

use rustls::client::UnbufferedClientConnection;
use rustls::pki_types::{ServerName, UnixTime};
use rustls::time_provider::TimeProvider;
use rustls::unbuffered::{AppDataRecord, ConnectionState, EncodeError, EncryptError, UnbufferedStatus};
use rustls::{ClientConfig, RootCertStore};

#[link(wasm_import_module = "env")]
extern "C" {
    fn now_ms() -> f64;
    fn random(ptr: *mut u8, len: usize);
}

fn page_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    // SAFETY: the page writes exactly `len` bytes into memory it was pointed at.
    unsafe { random(buf.as_mut_ptr(), buf.len()) };
    Ok(())
}
getrandom::register_custom_getrandom!(page_random);

/// Certificate validity is judged against the page's clock (wasm32 has none of its own).
#[derive(Debug)]
struct PageTime;
impl TimeProvider for PageTime {
    fn current_time(&self) -> Option<UnixTime> {
        // SAFETY: an import with no arguments.
        let ms = unsafe { now_ms() };
        (ms.is_finite() && ms > 0.0).then(|| UnixTime::since_unix_epoch(core::time::Duration::from_millis(ms as u64)))
    }
}

struct Session {
    conn: UnbufferedClientConnection,
    incoming: Vec<u8>,
    tls_out: Vec<u8>,
    plain_in: Vec<u8>,
    plain_out: Vec<u8>,
    scratch: Vec<u8>,
    close_requested: bool,
    close_sent: bool,
    peer_closed: bool,
    handshaking: bool,
}

/// Module state. wasm32v1-none has no threads, so one cell each is the whole story.
struct Global<T>(RefCell<T>);
// SAFETY: this target is single-threaded; no reference crosses threads.
unsafe impl<T> Sync for Global<T> {}
impl<T> Global<T> {
    fn with<R>(&self, f: impl FnOnce(&RefCell<T>) -> R) -> R {
        f(&self.0)
    }
}

static CONFIG: Global<Option<Arc<ClientConfig>>> = Global(RefCell::new(None));
static CONNS: Global<BTreeMap<u32, Session>> = Global(RefCell::new(BTreeMap::new()));
static NEXT: Global<u32> = Global(RefCell::new(1));
static OUT: Global<Vec<u8>> = Global(RefCell::new(Vec::new()));

fn config() -> Result<Arc<ClientConfig>, String> {
    CONFIG.with(|slot| {
        if let Some(cfg) = slot.borrow().as_ref() {
            return Ok(cfg.clone());
        }
        let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = ClientConfig::builder_with_details(provider, Arc::new(PageTime))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        // The page speaks HTTP/1.1 over the tunnel.
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let cfg = Arc::new(cfg);
        *slot.borrow_mut() = Some(cfg.clone());
        Ok(cfg)
    })
}

/// Advance the connection as far as the bytes at hand allow.
fn drive(s: &mut Session) -> Result<(), String> {
    let Session { conn, incoming, tls_out, plain_in, plain_out, scratch, close_requested, close_sent, peer_closed, handshaking } = s;
    loop {
        let UnbufferedStatus { mut discard, state } = conn.process_tls_records(&mut incoming[..]);
        let state = state.map_err(|e| format!("TLS: {e}"))?;
        let mut stop = false;
        match state {
            ConnectionState::ReadTraffic(mut rt) => {
                while let Some(record) = rt.next_record() {
                    let AppDataRecord { discard: more, payload } = record.map_err(|e| format!("TLS: {e}"))?;
                    discard += more;
                    plain_in.extend_from_slice(payload);
                }
            }
            ConnectionState::EncodeTlsData(mut st) => loop {
                match st.encode(scratch) {
                    Ok(n) => {
                        tls_out.extend_from_slice(&scratch[..n]);
                        break;
                    }
                    Err(EncodeError::InsufficientSize(e)) => scratch.resize(e.required_size, 0),
                    Err(e) => return Err(format!("TLS encode: {e:?}")),
                }
            },
            // The encoded records are queued in tls_out; the page sends them in order.
            ConnectionState::TransmitTlsData(st) => st.done(),
            ConnectionState::BlockedHandshake => stop = true,
            ConnectionState::WriteTraffic(mut wt) => {
                *handshaking = false;
                if !plain_out.is_empty() {
                    loop {
                        match wt.encrypt(plain_out, scratch) {
                            Ok(n) => {
                                tls_out.extend_from_slice(&scratch[..n]);
                                break;
                            }
                            Err(EncryptError::InsufficientSize(e)) => scratch.resize(e.required_size, 0),
                            Err(e) => return Err(format!("TLS encrypt: {e:?}")),
                        }
                    }
                    plain_out.clear();
                }
                if *close_requested && !*close_sent {
                    loop {
                        match wt.queue_close_notify(scratch) {
                            Ok(n) => {
                                tls_out.extend_from_slice(&scratch[..n]);
                                break;
                            }
                            Err(EncryptError::InsufficientSize(e)) => scratch.resize(e.required_size, 0),
                            Err(e) => return Err(format!("TLS close: {e:?}")),
                        }
                    }
                    *close_sent = true;
                }
                stop = true;
            }
            ConnectionState::PeerClosed | ConnectionState::Closed => {
                *peer_closed = true;
                stop = true;
            }
            _ => stop = true,
        }
        if discard > 0 {
            incoming.drain(..discard);
        }
        if stop {
            return Ok(());
        }
    }
}

fn set_out(bytes: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = bytes);
}

fn fail(message: impl Into<String>) -> i32 {
    set_out(message.into().into_bytes());
    -1
}

fn with_session<T>(h: u32, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    CONNS.with(|c| {
        let mut conns = c.borrow_mut();
        let s = conns.get_mut(&h).ok_or_else(|| "unknown TLS connection".to_string())?;
        f(s)
    })
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// # Safety
/// `ptr`/`len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn conn_new(host_ptr: *const u8, host_len: usize) -> u32 {
    let host = match core::str::from_utf8(core::slice::from_raw_parts(host_ptr, host_len)) {
        Ok(h) => h.to_string(),
        Err(_) => {
            fail("host is not UTF-8");
            return 0;
        }
    };
    let name = match ServerName::try_from(host) {
        Ok(n) => n,
        Err(e) => {
            fail(format!("invalid server name: {e}"));
            return 0;
        }
    };
    let conn = match config().and_then(|cfg| UnbufferedClientConnection::new(cfg, name).map_err(|e| e.to_string())) {
        Ok(c) => c,
        Err(e) => {
            fail(e);
            return 0;
        }
    };
    let mut session = Session {
        conn, incoming: Vec::new(), tls_out: Vec::new(), plain_in: Vec::new(), plain_out: Vec::new(),
        scratch: vec![0; 32 * 1024], close_requested: false, close_sent: false, peer_closed: false, handshaking: true,
    };
    if let Err(e) = drive(&mut session) {
        fail(e);
        return 0;
    }
    let h = NEXT.with(|n| {
        let mut n = n.borrow_mut();
        let h = *n;
        *n = n.wrapping_add(1).max(1);
        h
    });
    CONNS.with(|c| c.borrow_mut().insert(h, session));
    h
}

/// # Safety
/// `ptr`/`len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn conn_push_plain(h: u32, ptr: *const u8, len: usize) -> i32 {
    let data = core::slice::from_raw_parts(ptr, len);
    match with_session(h, |s| {
        s.plain_out.extend_from_slice(data);
        drive(s)
    }) {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// # Safety
/// `ptr`/`len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn conn_push_tls(h: u32, ptr: *const u8, len: usize) -> i32 {
    let data = core::slice::from_raw_parts(ptr, len);
    match with_session(h, |s| {
        s.incoming.extend_from_slice(data);
        // Certificate, hostname and record errors all surface here.
        drive(s)
    }) {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

#[no_mangle]
pub extern "C" fn conn_pull_tls(h: u32) -> i32 {
    match with_session(h, |s| Ok(core::mem::take(&mut s.tls_out))) {
        Ok(out) => {
            let n = out.len() as i32;
            set_out(out);
            n
        }
        Err(e) => fail(e),
    }
}

#[no_mangle]
pub extern "C" fn conn_pull_plain(h: u32) -> i32 {
    match with_session(h, |s| Ok((core::mem::take(&mut s.plain_in), s.peer_closed))) {
        Ok((out, closed)) => {
            let n = out.len() as i32;
            set_out(out);
            if closed && n == 0 { -2 } else { n }
        }
        Err(e) => fail(e),
    }
}

#[no_mangle]
pub extern "C" fn conn_handshaking(h: u32) -> u32 {
    with_session(h, |s| Ok(s.handshaking as u32)).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn conn_close(h: u32) {
    let _ = with_session(h, |s| {
        s.close_requested = true;
        drive(s)
    });
}

#[no_mangle]
pub extern "C" fn conn_free(h: u32) {
    CONNS.with(|c| c.borrow_mut().remove(&h));
}
