//! The native half of Remote Play. The app's window runs the WebRTC session
//! (src/host.ts); this is everything a page can't do, and the last line of
//! defence: whatever a connected phone asks for, it can only reach the game.
//!
//! - Input is checked in remote_input.rs, and sent only while 3DXChat is the
//!   front window and answering. A click or scroll goes out only when the game
//!   is the window under the pointer, never one lying on top of it.
//! - Capture is pointed at the game by giving its window, for a moment, a title
//!   only it has (`CAPTURE_TITLE`). The webview's automatic capture picks any
//!   window whose title *contains* a string, and "3DXChat" also matches a
//!   browser tab or an editor. The page then checks the captured handle too.
//! - Sound comes from the game's process alone, not the whole PC.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State,
};

use crate::remote_input::{absolute, actions_for, needs_game_in_front, pixel, Action, Held, MouseButton, PlayInput};
use crate::{game_window, secret};

/// The game window's title while capture picks it. The window's browser
/// arguments in tauri.conf.json select this.
const CAPTURE_TITLE: &str = "3dx-remote-play-capture";
/// What to put back if a crash left the capture title on the window.
const GAME_TITLE: &str = "3DXChat";
/// The title goes back by itself if the page never says capture finished.
const CAPTURE_TITLE_LIMIT: Duration = Duration::from_secs(6);
/// A game that hangs mid-capture can't take its title back at once, so it's
/// retried this often, for five minutes.
const TITLE_RESTORE_PAUSE: Duration = Duration::from_secs(1);
const TITLE_RESTORE_TRIES: u32 = 300;

const PAIRING_FILE: &str = "remote_play.pairing";
const MAX_PAIRING_LEN: usize = 8192;
/// Where 3DXChat was last seen running, so the phone can start it again.
const GAME_PATH_FILE: &str = "remote_play_game.txt";
/// The launcher starts the game with this.
const GAME_START_ARG: &str = "-start";
/// What happened on each connection. Only ever on this PC, and never with an
/// address or a secret in it (src/host.ts).
const LOG_FILE: &str = "remote_play.log";
/// Two files of this at most: a phone left retrying all night mustn't fill a disk.
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_LOG_LINE: usize = 600;

/// 100 ms of 48 kHz stereo float, matching `AudioData` in src/host.ts. Each
/// chunk is one trip through the app's message channel, which the phone's
/// controls share: 20 ms chunks (50 a second) slowed every message to
/// hundreds of milliseconds.
#[cfg(windows)]
const AUDIO_CHUNK_BYTES: usize = 4800 * 2 * 4;

struct RenamedWindow {
    handle: isize,
    title: String,
    generation: u64,
}

#[derive(Default)]
pub struct RemotePlayState {
    held: Mutex<Held>,
    renamed: Arc<Mutex<Option<RenamedWindow>>>,
    renames: AtomicU64,
    audio_stop: Mutex<Option<Arc<AtomicBool>>>,
    game_path: Mutex<Option<String>>,
}

impl RemotePlayState {
    pub fn release_held(&self) {
        let actions = self.held.lock().map(|mut held| held.release()).unwrap_or_default();
        run(actions);
    }
}

/// Injects at once; anything with a pause runs off to the side, so a click
/// never holds up the input behind it.
fn run(actions: Vec<Action>) {
    if actions.is_empty() {
        return;
    }
    if actions.iter().any(|action| matches!(action, Action::Wait { .. })) {
        thread::spawn(move || inject_all(&actions));
    } else {
        inject_all(&actions);
    }
}

fn inject_all(actions: &[Action]) {
    for group in actions.split_inclusive(|action| matches!(action, Action::Wait { .. })) {
        let (last, rest) = group.split_last().expect("split_inclusive yields no empty groups");
        if let Action::Wait { ms } = *last {
            win::inject(rest);
            thread::sleep(Duration::from_millis(ms));
        } else {
            win::inject(group);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    running: bool,
    responding: bool,
    minimized: bool,
    front: bool,
    locked: bool,
    can_launch: bool,
}

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join(name)).map_err(|error| error.to_string())
}

/// The game's executable, if `path` is one.
fn launchable(path: &Path) -> bool {
    path.to_str().is_some_and(game_window::is_game_path) && path.is_file()
}

fn remember_game_path(app: &AppHandle, state: &RemotePlayState, path: &str) {
    let Ok(mut known) = state.game_path.lock() else { return };
    if known.as_deref() == Some(path) {
        return;
    }
    *known = Some(path.to_string());
    if let Ok(file) = config_file(app, GAME_PATH_FILE) {
        if let Err(error) = fs::write(file, path) {
            log::warn!("couldn't remember where 3DXChat is: {error}");
        }
    }
}

fn known_game_path(app: &AppHandle, state: &RemotePlayState) -> Option<PathBuf> {
    let cached = state.game_path.lock().ok().and_then(|known| known.clone());
    let path = cached.or_else(|| fs::read_to_string(config_file(app, GAME_PATH_FILE).ok()?).ok())?;
    let path = PathBuf::from(path.trim());
    launchable(&path).then_some(path)
}

#[tauri::command]
pub fn remote_play_game_state(app: AppHandle, state: State<'_, RemotePlayState>) -> GameState {
    let game = game_window::find();
    if let Some(game) = &game {
        remember_game_path(&app, &state, &game.path);
    }
    GameState {
        running: game.is_some(),
        responding: game.as_ref().is_some_and(|game| !win::is_hung(game.handle)),
        minimized: game.as_ref().is_some_and(|game| win::is_minimized(game.handle)),
        front: game_window::is_in_front(),
        locked: win::session_locked(),
        can_launch: known_game_path(&app, &state).is_some(),
    }
}

/// For anything that waits on another app's window. On the main thread that
/// wait would hold up every other command and the app's own window too.
async fn off_main_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())
}

fn focus_game() -> Result<(), String> {
    let game = game_window::find().ok_or("3DXChat isn't running")?;
    if win::bring_to_front(game.handle) {
        Ok(())
    } else {
        Err("Windows kept another window in front".to_string())
    }
}

#[tauri::command]
pub async fn remote_play_focus_game() -> Result<(), String> {
    off_main_thread(focus_game).await?
}

/// Takes the game off the PC's screen. Bringing it back is `remote_play_focus_game`.
#[tauri::command]
pub async fn remote_play_minimize_game() -> Result<(), String> {
    let game = game_window::find().ok_or("3DXChat isn't running")?;
    if win::minimize(game.handle) {
        Ok(())
    } else {
        Err("Windows wouldn't minimize the game".to_string())
    }
}

/// How long since this PC last saw any keyboard or mouse input.
#[tauri::command]
pub fn remote_play_idle_ms() -> u64 {
    win::idle_ms()
}

#[tauri::command]
pub fn remote_play_launch_game(app: AppHandle, state: State<'_, RemotePlayState>) -> Result<(), String> {
    if game_window::find().is_some() {
        return Ok(());
    }
    let path = known_game_path(&app, &state).ok_or("3DXChat hasn't been opened on this PC yet")?;
    let folder = path.parent().ok_or("3DXChat's folder is missing")?;
    Command::new(&path).arg(GAME_START_ARG).current_dir(folder).spawn().map(drop).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remote_play_input(state: State<'_, RemotePlayState>, input: PlayInput) -> Result<(), String> {
    // Checked per event: the moment anything else is in front, keys and clicks
    // stop, so they can't land in a browser or a terminal. A frozen game gets
    // nothing either, or it would all play out at once when it came back.
    let answering = game_window::find().is_some_and(|game| !win::is_hung(game.handle));
    if !answering || !game_window::is_in_front() {
        state.release_held();
        return Err("3DXChat isn't in front and answering".to_string());
    }
    let actions = actions_for(&input)?;
    if let Ok(mut held) = state.held.lock() {
        held.note(&actions);
    }
    run(actions);
    Ok(())
}

/// Windows Hello, so someone at an unlocked PC can't quietly pair their own phone.
#[tauri::command]
pub async fn remote_play_verify_owner(window: tauri::WebviewWindow) -> Result<(), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    off_main_thread(move || win::verify_owner(handle)).await?
}

#[tauri::command]
pub fn remote_play_release(state: State<'_, RemotePlayState>) {
    state.release_held();
}

/// Gives the game its own title back. False while it can't take it (it's
/// hung), and the rename is kept for the next try. With a generation, only
/// that rename is undone, never a newer one.
fn restore_title(renamed: &Mutex<Option<RenamedWindow>>, generation: Option<u64>) -> bool {
    let Ok(mut slot) = renamed.lock() else { return true };
    let Some(window) = slot.take() else { return true };
    if generation.is_some_and(|wanted| wanted != window.generation) {
        *slot = Some(window);
        return true;
    }
    if win::set_title(window.handle, &window.title) || !win::is_window(window.handle) {
        return true;
    }
    *slot = Some(window);
    false
}

/// Makes the game the one window capture will pick, and returns its handle for
/// the page to check the capture against.
fn begin_capture(state: &RemotePlayState) -> Result<String, String> {
    let game = game_window::find().ok_or("3DXChat isn't running")?;
    if win::is_hung(game.handle) {
        return Err("3DXChat isn't responding".to_string());
    }
    restore_title(&state.renamed, None);
    let title = Some(game_window::title(game.handle)).filter(|title| title != CAPTURE_TITLE).unwrap_or_else(|| GAME_TITLE.to_string());
    let generation = state.renames.fetch_add(1, Ordering::Relaxed) + 1;
    if let Ok(mut slot) = state.renamed.lock() {
        *slot = Some(RenamedWindow { handle: game.handle, title, generation });
    }
    win::set_title(game.handle, CAPTURE_TITLE);
    let renamed = Arc::clone(&state.renamed);
    thread::spawn(move || {
        thread::sleep(CAPTURE_TITLE_LIMIT);
        for _ in 0..TITLE_RESTORE_TRIES {
            if restore_title(&renamed, Some(generation)) {
                return;
            }
            thread::sleep(TITLE_RESTORE_PAUSE);
        }
    });
    // Capture is asked for only once the game really wears the title: with no
    // window to match, the webview would ask on the PC which one to share.
    if game_window::title(game.handle) == CAPTURE_TITLE {
        Ok(game.handle.to_string())
    } else {
        restore_title(&state.renamed, Some(generation));
        Err("3DXChat didn't take the capture title".to_string())
    }
}

#[tauri::command]
pub async fn remote_play_capture_begin(app: AppHandle) -> Result<String, String> {
    off_main_thread(move || begin_capture(&app.state::<RemotePlayState>())).await?
}

#[tauri::command]
pub async fn remote_play_capture_end(app: AppHandle) -> Result<(), String> {
    off_main_thread(move || {
        restore_title(&app.state::<RemotePlayState>().renamed, None);
    })
    .await
}

/// While Remote Play is on the PC mustn't go to sleep, and during a session
/// neither may the screen, or the capture stops. Sync commands run on the main
/// thread, which outlives every session, so the request stays in force.
#[tauri::command]
pub fn remote_play_keep_awake(system: bool, display: bool) {
    win::keep_awake(system, display);
}

fn is_valid_pairing(pairing: &str) -> bool {
    pairing.len() <= MAX_PAIRING_LEN && serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(pairing).is_ok()
}

#[tauri::command]
pub fn remote_play_load_pairing(app: AppHandle) -> Result<Option<String>, String> {
    let pairing = secret::read(&config_file(&app, PAIRING_FILE)?)?;
    Ok(pairing.filter(|pairing| is_valid_pairing(pairing)))
}

#[tauri::command]
pub fn remote_play_save_pairing(app: AppHandle, pairing: String) -> Result<(), String> {
    if !is_valid_pairing(&pairing) {
        return Err("invalid pairing".to_string());
    }
    secret::write(&config_file(&app, PAIRING_FILE)?, &pairing)
}

/// One line, and not a long one: some of what's logged comes from the phone.
fn log_line(line: &str) -> String {
    line.chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_LOG_LINE).collect()
}

#[tauri::command]
pub fn remote_play_log(app: AppHandle, line: String) {
    let Ok(file) = config_file(&app, LOG_FILE) else { return };
    if let Some(folder) = file.parent() {
        let _ = fs::create_dir_all(folder);
    }
    if fs::metadata(&file).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(&file, file.with_extension("old.log"));
    }
    if let Ok(mut log) = fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(log, "{}", log_line(&line));
    }
}

#[tauri::command]
pub fn remote_play_audio_start(state: State<'_, RemotePlayState>, on_audio: Channel<InvokeResponseBody>) -> Result<(), String> {
    let game = game_window::find().ok_or("3DXChat isn't running")?;
    stop_audio(&state);
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut slot) = state.audio_stop.lock() {
        *slot = Some(Arc::clone(&stop));
    }
    thread::spawn(move || {
        if let Err(error) = win::stream_game_audio(game.process_id, &on_audio, &stop) {
            log::warn!("game audio stopped: {error}");
        }
    });
    Ok(())
}

fn stop_audio(state: &RemotePlayState) {
    if let Some(stop) = state.audio_stop.lock().ok().and_then(|mut slot| slot.take()) {
        stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn remote_play_audio_stop(state: State<'_, RemotePlayState>) {
    stop_audio(&state);
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::{collections::VecDeque, mem::size_of};

    use tauri::ipc::{Channel, InvokeResponseBody};
    use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetLastInputInfo, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, LASTINPUTINFO, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
        MAPVK_VK_TO_VSC, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClientRect, GetCursorPos, GetForegroundWindow, GetSystemMetrics, 
        IsHungAppWindow, IsIconic, IsWindow, SendMessageTimeoutW, SetForegroundWindow, ShowWindow, ShowWindowAsync, WindowFromPoint, GA_ROOT,
        SMTO_ABORTIFHUNG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_MINIMIZE, SW_RESTORE, WM_SETTEXT,
    };

    use super::{absolute, needs_game_in_front, pixel, Action, MouseButton, AUDIO_CHUNK_BYTES};
    use crate::game_window;

    /// A game just brought forward can take a while to answer.
    const SET_TITLE_TIMEOUT_MS: u32 = 4000;
    const AUDIO_WAIT_MS: u32 = 100;
    const AUDIO_SAMPLE_RATE: usize = 48_000;
    const AUDIO_CHANNELS: usize = 2;
    const AUDIO_BITS: usize = 32;

    fn hwnd(handle: isize) -> HWND {
        handle as HWND
    }

    fn keyboard(code: u16, scan: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: code, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn mouse(dx: i32, dy: i32, data: i32, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    /// A 0..1 point on the game as SendInput coordinates, if the game is there.
    fn game_position(x: f64, y: f64) -> Option<(i32, i32)> {
        let game = game_window::find()?;
        let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let mut origin = POINT { x: 0, y: 0 };
        let window = hwnd(game.handle);
        unsafe {
            if GetClientRect(window, &mut client) == 0 || ClientToScreen(window, &mut origin) == 0 {
                return None;
            }
            let px = pixel(origin.x, client.right - client.left, x);
            let py = pixel(origin.y, client.bottom - client.top, y);
            Some((
                absolute(px, GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN)),
                absolute(py, GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)),
            ))
        }
    }

    fn inputs_for(action: &Action, out: &mut Vec<INPUT>) {
        match *action {
            Action::MoveToGame { x, y } => {
                if let Some((dx, dy)) = game_position(x, y) {
                    out.push(mouse(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
                }
            }
            Action::MoveBy { dx, dy } => out.push(mouse(dx, dy, 0, MOUSEEVENTF_MOVE)),
            Action::Button { button, down } => {
                let flags = match (button, down) {
                    (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
                    (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
                    (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
                    (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
                };
                out.push(mouse(0, 0, 0, flags));
            }
            Action::Wheel { delta } => out.push(mouse(0, 0, delta, MOUSEEVENTF_WHEEL)),
            Action::Key { code, down } => {
                let scan = unsafe { MapVirtualKeyW(u32::from(code), MAPVK_VK_TO_VSC) } as u16;
                // The scan code alone, as a real keyboard sends it: some games ignore a key name.
                // The arrows and their block share scan codes with the number pad.
                let extended = if matches!(code, 0x21..=0x28 | 0x2E) { KEYEVENTF_EXTENDEDKEY } else { 0 };
                let up = if down { 0 } else { KEYEVENTF_KEYUP };
                out.push(keyboard(0, scan, KEYEVENTF_SCANCODE | extended | up));
            }
            Action::Char { unit } => {
                out.push(keyboard(0, unit, KEYEVENTF_UNICODE));
                out.push(keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            Action::Wait { .. } => {}
        }
    }

    /// A press goes to whatever is under the pointer, so it's sent only when
    /// that's the game: never a window lying on top of it.
    fn pointer_on_game() -> bool {
        let Some(game) = game_window::find() else { return false };
        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            if GetCursorPos(&mut point) == 0 {
                return false;
            }
            let under = WindowFromPoint(point);
            !under.is_null() && GetAncestor(under, GA_ROOT) == hwnd(game.handle)
        }
    }

    pub fn inject(actions: &[Action]) {
        let mut inputs = Vec::with_capacity(actions.len());
        for action in actions {
            let presses = matches!(action, Action::Button { down: true, .. } | Action::Wheel { .. });
            if presses && !pointer_on_game() {
                continue;
            }
            // Again here, not just when the input arrived: a message and its Enter
            // must never land in a terminal that came to the front in between.
            if needs_game_in_front(action) && !game_window::is_in_front() {
                continue;
            }
            inputs_for(action, &mut inputs);
        }
        if !inputs.is_empty() {
            unsafe {
                SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32);
            }
        }
    }

    pub fn verify_owner(handle: isize) -> Result<(), String> {
        use windows::core::{factory, HSTRING};
        use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
        use windows::Win32::Foundation::HWND as WinHwnd;
        use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
        use windows_future::IAsyncOperation;

        const NOT_SET_UP: &str = "Set up a Windows PIN first, in Settings, Accounts, Sign-in options. It keeps anyone else at this PC from pairing their own phone.";
        let failed = |error: windows::core::Error| format!("Windows Hello didn't start: {error}");

        let available = UserConsentVerifier::CheckAvailabilityAsync().and_then(|check| check.join()).map_err(failed)?;
        if available != UserConsentVerifierAvailability::Available {
            return Err(NOT_SET_UP.to_string());
        }
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(failed)?;
        let message = HSTRING::from("Confirm it's you to pair a phone with 3DX Remote Play");
        let result = unsafe {
            let request: IAsyncOperation<UserConsentVerificationResult> = interop.RequestVerificationForWindowAsync(WinHwnd(handle as *mut _), &message).map_err(failed)?;
            request.join().map_err(failed)?
        };
        if result == UserConsentVerificationResult::Verified {
            Ok(())
        } else {
            Err("Windows didn't confirm it's you, so nothing changed.".to_string())
        }
    }

    pub fn set_title(handle: isize, title: &str) -> bool {
        let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let mut result = 0usize;
        // With a timeout: SetWindowText would hang this thread if the game has.
        let sent = unsafe {
            SendMessageTimeoutW(hwnd(handle), WM_SETTEXT, 0, wide.as_ptr() as isize, SMTO_ABORTIFHUNG, SET_TITLE_TIMEOUT_MS, &mut result)
        };
        sent != 0 && result != 0
    }

    /// Windows' own test: the window hasn't taken a message for five seconds.
    pub fn is_hung(handle: isize) -> bool {
        unsafe { IsHungAppWindow(hwnd(handle)) != 0 }
    }

    pub fn is_minimized(handle: isize) -> bool {
        unsafe { IsIconic(hwnd(handle)) != 0 }
    }

    /// Asynchronous, so a hung game can't hold this up.
    pub fn minimize(handle: isize) -> bool {
        unsafe { ShowWindowAsync(hwnd(handle), SW_MINIMIZE) != 0 }
    }

    pub fn idle_ms() -> u64 {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            u64::from(GetTickCount().wrapping_sub(info.dwTime))
        }
    }

    pub fn is_window(handle: isize) -> bool {
        unsafe { IsWindow(hwnd(handle)) != 0 }
    }

    /// Windows lets only the app in front hand over the focus, so if asking isn't
    /// enough, a tap of Alt counts as use. Never share input with the window in front:
    /// with this app's own window there, that ties into WebView2's threads and deadlocks them.
    pub fn bring_to_front(handle: isize) -> bool {
        let window = hwnd(handle);
        unsafe {
            if IsIconic(window) != 0 {
                ShowWindow(window, SW_RESTORE);
            }
            if GetForegroundWindow() == window {
                return true;
            }
            SetForegroundWindow(window);
            if GetForegroundWindow() == window {
                return true;
            }
            let alt = [keyboard(VK_MENU, 0, 0), keyboard(VK_MENU, 0, KEYEVENTF_KEYUP)];
            SendInput(alt.len() as u32, alt.as_ptr(), size_of::<INPUT>() as i32);
            SetForegroundWindow(window);
            GetForegroundWindow() == window
        }
    }

    /// The lock screen (and UAC) run on a desktop other than "Default".
    pub fn session_locked() -> bool {
        unsafe {
            let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desktop.is_null() {
                return true;
            }
            let mut name = [0u16; 32];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(desktop as _, UOI_NAME, name.as_mut_ptr().cast(), (name.len() * 2) as u32, &mut needed);
            CloseDesktop(desktop);
            let length = name.iter().position(|unit| *unit == 0).unwrap_or(name.len());
            ok == 0 || String::from_utf16_lossy(&name[..length]) != "Default"
        }
    }

    pub fn keep_awake(system: bool, display: bool) {
        let mut flags = ES_CONTINUOUS;
        if system {
            flags |= ES_SYSTEM_REQUIRED;
        }
        if display {
            flags |= ES_DISPLAY_REQUIRED;
        }
        unsafe {
            SetThreadExecutionState(flags);
        }
    }

    /// Streams what one process plays until told to stop. Windows mixes and
    /// converts it to the format asked for, and it's silent (no events) while
    /// the game makes no sound.
    pub fn stream_game_audio(process_id: u32, sink: &Channel<InvokeResponseBody>, stop: &AtomicBool) -> Result<(), String> {
        let text = |error: wasapi::WasapiError| error.to_string();
        let _ = initialize_mta();
        let format = WaveFormat::new(AUDIO_BITS, AUDIO_BITS, &SampleType::Float, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, None);
        let mut client = AudioClient::new_application_loopback_client(process_id, true).map_err(text)?;
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
        client.initialize_client(&format, &Direction::Capture, &mode).map_err(text)?;
        let event = client.set_get_eventhandle().map_err(text)?;
        let capture = client.get_audiocaptureclient().map_err(text)?;
        client.start_stream().map_err(text)?;

        let mut queue: VecDeque<u8> = VecDeque::new();
        while !stop.load(Ordering::Relaxed) {
            if capture.get_next_packet_size().map_err(text)?.unwrap_or(0) > 0 {
                capture.read_from_device_to_deque(&mut queue).map_err(text)?;
            }
            while queue.len() >= AUDIO_CHUNK_BYTES {
                let chunk: Vec<u8> = queue.drain(..AUDIO_CHUNK_BYTES).collect();
                sink.send(InvokeResponseBody::Raw(chunk)).map_err(|error| error.to_string())?;
            }
            let _ = event.wait_for_event(AUDIO_WAIT_MS);
        }
        client.stop_stream().map_err(text)
    }
}

#[cfg(not(windows))]
mod win {
    use std::sync::atomic::AtomicBool;

    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::Action;

    pub fn inject(_actions: &[Action]) {}

    pub fn verify_owner(_handle: isize) -> Result<(), String> {
        Err("Windows Hello needs Windows".to_string())
    }

    pub fn set_title(_handle: isize, _title: &str) -> bool {
        false
    }

    pub fn is_hung(_handle: isize) -> bool {
        false
    }

    pub fn is_minimized(_handle: isize) -> bool {
        false
    }

    pub fn minimize(_handle: isize) -> bool {
        false
    }

    pub fn idle_ms() -> u64 {
        0
    }

    pub fn is_window(_handle: isize) -> bool {
        false
    }

    pub fn bring_to_front(_handle: isize) -> bool {
        false
    }

    pub fn session_locked() -> bool {
        false
    }

    pub fn keep_awake(_system: bool, _display: bool) {}

    pub fn stream_game_audio(_process_id: u32, _sink: &Channel<InvokeResponseBody>, _stop: &AtomicBool) -> Result<(), String> {
        Err("game audio needs Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_json_object_of_sane_size_is_a_pairing() {
        assert!(is_valid_pairing(r#"{"enabled":true,"room":"ab"}"#));
        assert!(!is_valid_pairing("not json"));
        assert!(!is_valid_pairing("[1,2,3]"));
        assert!(!is_valid_pairing(&format!(r#"{{"a":"{}"}}"#, "x".repeat(MAX_PAIRING_LEN))));
    }

    #[test]
    fn a_log_line_stays_one_short_line() {
        assert_eq!(log_line("one\r\ntwo"), "one  two");
        assert_eq!(log_line(&"x".repeat(MAX_LOG_LINE * 2)).chars().count(), MAX_LOG_LINE);
    }

    #[test]
    fn a_title_is_only_put_back_by_its_own_rename() {
        let renamed = Mutex::new(Some(RenamedWindow { handle: 0, title: GAME_TITLE.to_string(), generation: 2 }));
        assert!(restore_title(&renamed, Some(1)), "an older rename gives up");
        assert!(renamed.lock().unwrap().is_some(), "and leaves the newer one alone");
        assert!(restore_title(&renamed, Some(2)), "a window that's gone isn't retried");
        assert!(renamed.lock().unwrap().is_none());
    }

    #[test]
    fn capture_selects_only_the_title_this_app_sets() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let args = config["app"]["windows"][0]["additionalBrowserArgs"].as_str().unwrap();
        let selected = args.split("--auto-select-desktop-capture-source=").nth(1).unwrap();
        assert_eq!(selected.split_whitespace().next(), Some(CAPTURE_TITLE));
        // Capture picks any window whose title contains this, so it must never
        // be something an editor or a browser tab could be called.
        assert!(!CAPTURE_TITLE.to_ascii_lowercase().contains("3dxchat"));
    }

    #[test]
    fn starting_in_the_tray_leaves_the_focus_where_it_was() {
        // The window starts hidden, and by default it would still take the focus
        // from whatever is in front, like the game, and swallow what's typed.
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["visible"], false);
        assert_eq!(window["focus"], false);
    }

    #[test]
    fn bringing_the_game_forward_shares_no_input() {
        // It froze the app: Windows reported a deadlock inside WebView2.
        let call = ["Attach", "ThreadInput("].concat();
        assert!(!include_str!("remote_play.rs").contains(&call));
    }

    #[test]
    fn only_the_game_executable_can_be_launched() {
        let dir = tempfile::tempdir().unwrap();
        let game = dir.path().join("3DXChat.exe");
        let other = dir.path().join("cmd.exe");
        fs::write(&game, b"").unwrap();
        fs::write(&other, b"").unwrap();
        assert!(launchable(&game));
        assert!(!launchable(&other));
        assert!(!launchable(&dir.path().join("3dxchat.exe.bak")));
        assert!(!launchable(dir.path()));
    }
}
