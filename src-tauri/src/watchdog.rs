//! Brings the app back from a freeze that nobody at the PC can fix.
//!
//! Every capture opens Chromium's window picker for a moment. Closing it makes
//! the browser's main thread wait for the thumbnail thread, and if that thread is
//! taking a thumbnail of one of the browser's own windows, each waits on the other
//! for good (seen in a debugger: NativeDesktopMediaList's destructor joining a
//! thread stuck in PrintWindow). This app's main thread then hangs behind them.
//! The phone could be anywhere, so waiting for a click would strand it. A frozen
//! app has nothing left to lose, so this restarts it in the tray, and the phone
//! reconnects by itself.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::remote_play::{remote_play_log, RemotePlayState};

const CHECK_EVERY: Duration = Duration::from_secs(5);
const FROZEN_AFTER: Duration = Duration::from_secs(20);
/// A check this late means the PC was asleep, not that the app froze.
const ASLEEP_AFTER: Duration = Duration::from_secs(30);
/// More restarts than this, each after only a short run, and it's not going to help.
const MAX_RECOVERIES: u32 = 3;
const SHORT_RUN: Duration = Duration::from_secs(5 * 60);
pub const RECOVERED_ARG: &str = "--recovered=";

/// How many restarts this start came after, from the app's arguments.
pub fn recoveries_from(args: impl Iterator<Item = String>) -> u32 {
    args.filter_map(|arg| arg.strip_prefix(RECOVERED_ARG).and_then(|count| count.parse().ok())).next().unwrap_or(0)
}

/// Which restart this would be, or None if restarting keeps not helping.
fn next_recovery(previous: u32, ran_for: Duration) -> Option<u32> {
    let next = if ran_for < SHORT_RUN { previous + 1 } else { 1 };
    (next <= MAX_RECOVERIES).then_some(next)
}

pub fn start(app: AppHandle, recoveries: u32) {
    thread::spawn(move || {
        let started = Instant::now();
        let last_answer = Arc::new(AtomicU64::new(0));
        let mut last_check = started;
        loop {
            thread::sleep(CHECK_EVERY);
            if last_check.elapsed() > ASLEEP_AFTER {
                last_answer.store(started.elapsed().as_secs(), Ordering::Relaxed);
            }
            last_check = Instant::now();
            let answer = Arc::clone(&last_answer);
            let _ = app.run_on_main_thread(move || answer.store(started.elapsed().as_secs(), Ordering::Relaxed));
            let silent_for = started.elapsed().as_secs().saturating_sub(last_answer.load(Ordering::Relaxed));
            if silent_for < FROZEN_AFTER.as_secs() {
                continue;
            }
            let Some(next) = next_recovery(recoveries, started.elapsed()) else {
                remote_play_log(app.clone(), "froze again soon after restarting: leaving it for you to close".to_string());
                return;
            };
            remote_play_log(app.clone(), format!("froze: restarting by itself (time {next})"));
            app.state::<RemotePlayState>().release_held();
            restart(next);
            return;
        }
    });
}

#[cfg(windows)]
fn restart(recoveries: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const WEBVIEW: &str = "msedgewebview2.exe";
    const BROWSER_EXIT_WAIT_MS: u32 = 8000;

    let Ok(exe) = std::env::current_exe() else { return };
    let start = format!("start \"\" \"{}\" {} {}{}", exe.display(), crate::MINIMIZED_ARG, RECOVERED_ARG, recoveries);
    // The pause lets this copy go, so it can't take the new one's start for its own. The
    // second start is for a browser that outlived the kill: a copy started too soon
    // attaches to it and quits. If the first worked, the second just finds it running.
    let command = format!("/c ping -n 3 127.0.0.1 >nul & {start} & ping -n 21 127.0.0.1 >nul & {start}");
    unsafe {
        // The stuck browser has to go too, or the new copy would attach to it and hang.
        let own = GetCurrentProcessId();
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                let length = entry.szExeFile.iter().position(|unit| *unit == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
                if entry.th32ParentProcessID == own && name.eq_ignore_ascii_case(WEBVIEW) {
                    let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, entry.th32ProcessID);
                    if !process.is_null() {
                        TerminateProcess(process, 1);
                        WaitForSingleObject(process, BROWSER_EXIT_WAIT_MS);
                        CloseHandle(process);
                    }
                }
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        if Command::new("cmd").raw_arg(command).creation_flags(CREATE_NO_WINDOW).spawn().is_err() {
            return;
        }
        // Not a normal exit: that would wait on the frozen main thread.
        TerminateProcess(GetCurrentProcess(), 1);
    }
}

#[cfg(not(windows))]
fn restart(_recoveries: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    const LONG_RUN: Duration = Duration::from_secs(60 * 60);
    const BRIEF: Duration = Duration::from_secs(30);

    #[test]
    fn a_freeze_after_a_good_run_starts_the_count_over() {
        assert_eq!(next_recovery(0, LONG_RUN), Some(1));
        assert_eq!(next_recovery(3, LONG_RUN), Some(1));
    }

    #[test]
    fn it_stops_restarting_when_restarting_keeps_not_helping() {
        assert_eq!(next_recovery(0, BRIEF), Some(1));
        assert_eq!(next_recovery(2, BRIEF), Some(3));
        assert_eq!(next_recovery(3, BRIEF), None);
    }

    #[test]
    fn it_reads_the_count_from_its_arguments() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>().into_iter();
        assert_eq!(recoveries_from(args(&["app", "--minimized"])), 0);
        assert_eq!(recoveries_from(args(&["app", "--minimized", "--recovered=2"])), 2);
        assert_eq!(recoveries_from(args(&["app", "--recovered=nonsense"])), 0);
    }
}
