/// Every command in lib.rs's generate_handler!. The page's address counts as
/// remote, so each one needs a permission, listed in capabilities/default.json.
/// A unit test keeps the three lists in step.
const COMMANDS: &[&str] = &[
    "remote_play_game_state",
    "remote_play_focus_game",
    "remote_play_launch_game",
    "remote_play_input",
    "remote_play_release",
    "remote_play_capture_begin",
    "remote_play_capture_end",
    "remote_play_keep_awake",
    "remote_play_load_pairing",
    "remote_play_save_pairing",
    "remote_play_log",
    "remote_play_audio_start",
    "remote_play_audio_stop",
    "remote_play_show_connected",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
