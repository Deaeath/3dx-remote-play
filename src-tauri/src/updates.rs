//! Updates from the GitHub releases. Each one is signed with a key that never
//! leaves the maintainer's PC, and the updater refuses anything else, so taking
//! over the GitHub account can't put code on anyone's PC.
//!
//! An update waiting when the app starts goes in straight away, before anyone
//! can be using it. One found later never restarts the app by itself: it waits
//! for a click in the tray.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use crate::remote_play::{remote_play_log, RemotePlayState};

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Long enough for the first check and its download, on a slow line.
const JUST_STARTED: Duration = Duration::from_secs(3 * 60);

#[derive(Default)]
pub struct UpdateState {
    phone_connected: AtomicBool,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

impl UpdateState {
    pub fn set_phone_connected(&self, connected: bool) {
        self.phone_connected.store(connected, Ordering::Relaxed);
    }
}

fn note(app: &AppHandle, line: String) {
    remote_play_log(app.clone(), line);
}

/// Goes in now only if the app has just started and no phone has got on yet.
fn may_install_now(elapsed: Duration, phone_connected: bool) -> bool {
    elapsed < JUST_STARTED && !phone_connected
}

async fn check(app: &AppHandle, started: Instant) -> Result<(), Error> {
    let state = app.state::<UpdateState>();
    if state.ready.lock().map(|ready| ready.is_some()).unwrap_or(false) {
        return Ok(());
    }
    let Some(update) = app.updater()?.check().await? else {
        note(app, "update: already on the newest version".to_string());
        return Ok(());
    };
    note(app, format!("update: found {}, downloading", update.version));
    // This is where a bad signature gets refused.
    let bytes = update.download(|_, _| {}, || {}).await?;
    let version = update.version.clone();
    if may_install_now(started.elapsed(), state.phone_connected.load(Ordering::Relaxed)) {
        note(app, format!("update: installing {version}"));
        update.install(&bytes)?;
        return Ok(());
    }
    note(app, format!("update: {version} is ready"));
    if let Ok(mut ready) = state.ready.lock() {
        *ready = Some((update, bytes));
    }
    if let Err(error) = crate::offer_update(app, &version) {
        note(app, format!("update: couldn't add it to the tray: {error}"));
    }
    let _ = app
        .notification()
        .builder()
        .title("3DX Remote Play")
        .body(format!("Version {version} is ready. Choose Restart to update from the tray icon."))
        .show();
    Ok(())
}

pub fn start(app: AppHandle) {
    let reporter = app.clone();
    let earlier = std::panic::take_hook();
    // A tray app has no console, so a panic would otherwise vanish, taking the updater with it.
    std::panic::set_hook(Box::new(move |info| {
        note(&reporter, format!("crash: {info}"));
        earlier(info);
    }));
    thread::spawn(move || {
        let started = Instant::now();
        loop {
            note(&app, format!("update: checking from {}", app.package_info().version));
            match tauri::async_runtime::block_on(check(&app, started)) {
                Ok(()) => {}
                // A release with no signed update yet, which isn't a problem.
                Err(Error::ReleaseNotFound) => note(&app, "update: no signed update published".to_string()),
                Err(error) => note(&app, format!("update: {error}")),
            }
            thread::sleep(CHECK_EVERY);
        }
    });
}

/// The tray's Restart to update.
pub fn install_ready(app: &AppHandle) {
    let ready = app.state::<UpdateState>().ready.lock().ok().and_then(|mut ready| ready.take());
    let Some((update, bytes)) = ready else { return };
    app.state::<RemotePlayState>().release_held();
    if let Err(error) = update.install(&bytes) {
        note(app, format!("update: couldn't install: {error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_only_restarts_unasked_right_after_starting_with_no_phone_on() {
        assert!(may_install_now(Duration::from_secs(5), false));
        assert!(!may_install_now(Duration::from_secs(5), true));
        assert!(!may_install_now(JUST_STARTED, false));
        assert!(!may_install_now(CHECK_EVERY, false));
    }

    #[test]
    fn updates_must_be_signed_and_come_over_https() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert!(updater["pubkey"].as_str().is_some_and(|key| key.len() > 40));
        assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
        for endpoint in updater["endpoints"].as_array().unwrap() {
            assert!(endpoint.as_str().unwrap().starts_with("https://github.com/Deaeath/3dx-remote-play/"));
        }
        // No signing key in the build: signing happens on the maintainer's PC.
        assert!(config["bundle"].get("createUpdaterArtifacts").is_none());
    }
}
