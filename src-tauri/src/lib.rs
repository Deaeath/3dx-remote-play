mod game_window;
mod remote_input;
mod remote_play;
mod secret;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

const MAIN_WINDOW: &str = "main";
/// What the Open with Windows entry passes, so a start with Windows stays in the tray.
const MINIMIZED_ARG: &str = "--minimized";
const TRAY_OPEN: &str = "open";
const TRAY_QUIT: &str = "quit";

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN, "Open 3DX Remote Play", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip("3DX Remote Play")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => show_main(app),
            TRAY_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second start opens the one that's running: two hosts would fight
        // over the game.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
        .manage(remote_play::RemotePlayState::default())
        .setup(|app| {
            setup_tray(app.handle())?;
            if !std::env::args().any(|arg| arg == MINIMIZED_ARG) {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray, so the PC stays ready for the phone.
            // Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            remote_play::remote_play_game_state,
            remote_play::remote_play_focus_game,
            remote_play::remote_play_launch_game,
            remote_play::remote_play_input,
            remote_play::remote_play_release,
            remote_play::remote_play_capture_begin,
            remote_play::remote_play_capture_end,
            remote_play::remote_play_keep_awake,
            remote_play::remote_play_load_pairing,
            remote_play::remote_play_save_pairing,
            remote_play::remote_play_audio_start,
            remote_play::remote_play_audio_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 3DX Remote Play");
}
