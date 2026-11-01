mod game_window;
mod remote_input;
mod remote_play;
mod secret;
mod updates;

use tauri::http::{header, Response, StatusCode};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const MAIN_WINDOW: &str = "main";
const PAGE_SCHEME: &str = "remote-play";
/// The bar Windows shows while the game is shared names the page's address, and
/// the default, tauri.localhost, reads like something's wrong. This one becomes
/// https://remote-play.3dx/ and is answered by `serve_page`, never the network.
const PAGE_URL: &str = "remote-play://3dx/";
/// What the Open with Windows entry passes, so a start with Windows stays in the tray.
const MINIMIZED_ARG: &str = "--minimized";
const TRAY_OPEN: &str = "open";
const TRAY_QUIT: &str = "quit";
const TRAY_UPDATE: &str = "update";
const TRAY_ID: &str = "tray";
const TRAY_TOOLTIP: &str = "3DX Remote Play";
const MAX_PHONE_NAME_CHARS: usize = 40;
/// How much of the icon the connected dot covers, as a fraction of its width.
const DOT_WIDTH: f64 = 0.5;
const DOT_COLOUR: [u8; 4] = [0xE5, 0x39, 0x35, 0xFF];

fn serve_page(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let Some(asset) = app.asset_resolver().get(path.to_string()) else {
        return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_default();
    };
    let mut response = Response::builder().header(header::CONTENT_TYPE, asset.mime_type());
    if let Some(csp) = asset.csp_header() {
        response = response.header(header::CONTENT_SECURITY_POLICY, csp);
    }
    response.body(asset.bytes).unwrap_or_default()
}

fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let mut config = app.config().app.windows[0].clone();
    // `tauri dev` serves the page itself.
    if !tauri::is_dev() {
        config.url = WebviewUrl::CustomProtocol(PAGE_URL.parse().expect("PAGE_URL is a URL"));
    }
    WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The icon with a red dot in its corner: someone at the PC can see a phone is
/// connected without hovering, and even if Windows held the notification back.
fn with_connected_dot(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut pixels = rgba.to_vec();
    let radius = f64::from(width.min(height)) * DOT_WIDTH / 2.0;
    let (centre_x, centre_y) = (f64::from(width) - radius, f64::from(height) - radius);
    for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
        let x = (index as u32 % width.max(1)) as f64 + 0.5;
        let y = (index as u32 / width.max(1)) as f64 + 0.5;
        if (x - centre_x).hypot(y - centre_y) <= radius {
            pixel.copy_from_slice(&DOT_COLOUR);
        }
    }
    pixels
}

/// Shows on the tray whether a phone is connected, and which.
#[tauri::command]
fn remote_play_show_connected(app: AppHandle, phone: Option<String>) -> Result<(), String> {
    app.state::<updates::UpdateState>().set_phone_connected(phone.is_some());
    let tray = app.tray_by_id(TRAY_ID).ok_or("the tray icon is missing")?;
    let icon = app.default_window_icon().ok_or("the app has no icon")?;
    let tooltip = match &phone {
        Some(name) => {
            let name: String = name.chars().filter(|c| !c.is_control()).take(MAX_PHONE_NAME_CHARS).collect();
            format!("{TRAY_TOOLTIP}: {name} is connected")
        }
        None => TRAY_TOOLTIP.to_string(),
    };
    let image = if phone.is_some() {
        Image::new_owned(with_connected_dot(icon.rgba(), icon.width(), icon.height()), icon.width(), icon.height())
    } else {
        icon.clone()
    };
    tray.set_icon(Some(image)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|error| error.to_string())
}

fn tray_menu(app: &AppHandle, update: Option<&str>) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, TRAY_OPEN, "Open 3DX Remote Play", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    match update {
        Some(version) => {
            let restart = MenuItem::with_id(app, TRAY_UPDATE, format!("Restart to update to {version}"), true, None::<&str>)?;
            Menu::with_items(app, &[&open, &restart, &separator, &quit])
        }
        None => Menu::with_items(app, &[&open, &separator, &quit]),
    }
}

/// Puts the waiting update in the tray menu.
pub fn offer_update(app: &AppHandle, version: &str) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(tray_menu(app, Some(version))?))?;
    }
    Ok(())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app, None)?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => show_main(app),
            TRAY_UPDATE => updates::install_ready(app),
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_ARG])))
        .manage(remote_play::RemotePlayState::default())
        .manage(updates::UpdateState::default())
        .register_uri_scheme_protocol(PAGE_SCHEME, |context, request| serve_page(context.app_handle(), request.uri().path()))
        .setup(|app| {
            open_main_window(app.handle())?;
            setup_tray(app.handle())?;
            if !tauri::is_dev() {
                updates::start(app.handle().clone());
            }
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
            remote_play::remote_play_log,
            remote_play::remote_play_audio_start,
            remote_play::remote_play_audio_stop,
            remote_play::remote_play_verify_owner,
            remote_play::remote_play_minimize_game,
            remote_play::remote_play_idle_ms,
            remote_play_show_connected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 3DX Remote Play");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap()
    }

    #[test]
    fn the_page_may_call_every_command() {
        // A command left out of a list only fails in the running app.
        let capability = capability();
        let permissions = capability["permissions"].as_array().unwrap();
        let handler = include_str!("lib.rs").split("generate_handler![").nth(1).unwrap().split(']').next().unwrap();
        let names: Vec<&str> = handler.split(',').map(str::trim).filter(|line| !line.is_empty()).map(|line| line.rsplit("::").next().unwrap()).collect();
        assert_eq!(names.len(), 17);
        for name in names {
            assert!(include_str!("../build.rs").contains(&format!("\"{name}\"")), "{name} isn't in build.rs");
            let permission = format!("allow-{}", name.replace('_', "-"));
            assert!(permissions.iter().any(|entry| entry.as_str() == Some(permission.as_str())), "{permission} isn't in the capability");
        }
    }

    #[test]
    fn the_connected_dot_sits_in_the_corner_and_leaves_the_rest() {
        let plain = vec![9u8; 4 * 100 * 100];
        let dotted = with_connected_dot(&plain, 100, 100);
        let at = |x: usize, y: usize| &dotted[(y * 100 + x) * 4..(y * 100 + x) * 4 + 4];
        assert_eq!(at(75, 75), &DOT_COLOUR);
        assert_eq!(at(10, 10), &[9, 9, 9, 9]);
        assert_eq!(dotted.len(), plain.len());
    }

    #[test]
    fn the_address_agrees_everywhere() {
        // Anything else needs https to be a secure context, or capture and crypto vanish.
        assert_eq!(PAGE_URL, format!("{PAGE_SCHEME}://3dx/"));
        assert_eq!(capability()["remote"]["urls"][0], "https://remote-play.3dx/*");
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["useHttpsScheme"], true);
        assert_eq!(window["create"], false);
        assert!(config["app"]["security"]["csp"]["connect-src"].as_str().unwrap().contains("https://ipc.localhost"));
    }
}
