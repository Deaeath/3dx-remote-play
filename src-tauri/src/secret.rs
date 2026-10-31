//! The pairing at rest: a file in the app's config folder, encrypted with
//! Windows DPAPI for the signed-in user, so another account, or a copy of the
//! file on another PC, can't open it.

use std::{fs, io::ErrorKind, path::Path};

/// Extra entropy, so the blob opens only as this app's pairing.
const PURPOSE: &[u8] = b"3dx-remote-play/pairing";

/// The secret, or `None` if there is none or it can't be opened here.
pub fn read(path: &Path) -> Result<Option<String>, String> {
    let sealed = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    Ok(unseal(&sealed).and_then(|plain| String::from_utf8(plain).ok()))
}

/// Writes next to the file and renames over it, so a crash never leaves half.
pub fn write(path: &Path, secret: &str) -> Result<(), String> {
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, seal(secret.as_bytes())?).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

#[cfg(windows)]
fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(plain, true)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
    dpapi(sealed, false).ok()
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    let blob = |data: &[u8]| CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let data = blob(input);
    let entropy = blob(PURPOSE);
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if protect {
            CryptProtectData(&data, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&data, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 || output.pbData.is_null() {
        return Err(format!("DPAPI failed: {}", std::io::Error::last_os_error()));
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
    Some(sealed.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_round_trips_and_is_replaced_whole() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("nested").join("remote_play.pairing");
        assert_eq!(read(&path).unwrap(), None);
        write(&path, r#"{"room":"first"}"#).unwrap();
        write(&path, r#"{"room":"second"}"#).unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some(r#"{"room":"second"}"#));
        let leftovers = fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary file left behind");
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_file_is_not_plaintext() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("remote_play.pairing");
        write(&path, "SECRET-ROOM").unwrap();
        assert!(!fs::read(&path).unwrap().windows(11).any(|window| window == b"SECRET-ROOM"));
        assert_eq!(read(&path).unwrap().as_deref(), Some("SECRET-ROOM"));
    }
}
