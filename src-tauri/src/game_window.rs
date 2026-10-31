//! Finding 3DXChat's window: by its process and its window class, never by
//! title alone, because any app can have "3DXChat" in its title (a browser
//! tab about the game, an editor).

use std::path::Path;

pub struct GameWindow {
    pub handle: isize,
    pub process_id: u32,
    pub path: String,
}

const GAME_EXE: &str = "3dxchat.exe";

/// Whether `path` is 3DXChat's executable.
pub fn is_game_path(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(GAME_EXE))
}

#[cfg(windows)]
pub use imp::{find, is_in_front, title};

#[cfg(windows)]
mod imp {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    use super::{is_game_path, GameWindow};

    /// Unity's class for a game's own window.
    const GAME_CLASS: &str = "UnityWndClass";

    /// The game's main window, in front or not.
    pub fn find() -> Option<GameWindow> {
        unsafe extern "system" fn visit(hwnd: HWND, found: LPARAM) -> BOOL {
            let found = &mut *(found as *mut Option<GameWindow>);
            if IsWindowVisible(hwnd) == 0 || class_name(hwnd) != GAME_CLASS {
                return 1;
            }
            let mut process_id = 0u32;
            GetWindowThreadProcessId(hwnd, &mut process_id);
            match process_path(process_id) {
                Some(path) if is_game_path(&path) => {
                    *found = Some(GameWindow { handle: hwnd as isize, process_id, path });
                    0
                }
                _ => 1,
            }
        }

        let mut found: Option<GameWindow> = None;
        unsafe {
            EnumWindows(Some(visit), &mut found as *mut Option<GameWindow> as LPARAM);
        }
        found
    }

    /// The game itself is the window in front.
    pub fn is_in_front() -> bool {
        let front = unsafe { GetForegroundWindow() };
        find().is_some_and(|game| game.handle == front as isize)
    }

    pub fn title(handle: isize) -> String {
        let hwnd = handle as HWND;
        unsafe {
            let length = GetWindowTextLengthW(hwnd);
            if length <= 0 {
                return String::new();
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
        }
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buffer = [0u16; 64];
        let copied = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
    }

    fn process_path(process_id: u32) -> Option<String> {
        if process_id == 0 {
            return None;
        }
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut buffer = vec![0u16; 32_768];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(process);
            (ok != 0 && size > 0).then(|| OsString::from_wide(&buffer[..size as usize]).to_string_lossy().into_owned())
        }
    }
}

#[cfg(not(windows))]
pub fn find() -> Option<GameWindow> {
    None
}

#[cfg(not(windows))]
pub fn is_in_front() -> bool {
    false
}

#[cfg(not(windows))]
pub fn title(_handle: isize) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::is_game_path;

    #[test]
    fn only_the_game_executable_counts() {
        assert!(is_game_path(r"C:\Games\3DXChat\Game\3DXChat.exe"));
        assert!(is_game_path(r"D:\3dxchat\3dxchat.EXE"));
        assert!(!is_game_path(r"C:\Program Files\Microsoft VS Code\Code.exe"));
        assert!(!is_game_path(r"C:\Games\3DXChat\Launcher\3DXLauncher.exe"));
        assert!(!is_game_path(r"C:\Games\3DXChat.exe.bak"));
        assert!(!is_game_path(""));
    }
}
