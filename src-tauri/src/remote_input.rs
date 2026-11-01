//! What a phone may do to the game, as plain data. This is Remote Play's
//! safety boundary, so it's kept apart from the code that talks to Windows:
//! input is a short list of game actions, never raw key codes. No Windows key,
//! Alt or Ctrl exists here, so nothing like Alt+Tab or Alt+F4 can be built.

use serde::Deserialize;

pub const MAX_TEXT_CHARS: usize = 240;
const MAX_LOOK: i32 = 2000;
const MAX_WHEEL_TICKS: i32 = 10;
const WHEEL_NOTCH: i32 = 120;
/// Unity reads input once a frame, so a press shorter than a frame goes unseen.
const KEY_HOLD_MS: u64 = 60;
const CLICK_SETTLE_MS: u64 = 30;
const CLICK_HOLD_MS: u64 = 50;
const ENTER: u16 = 0x0D;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
}

/// What a phone may ask for. Mirrors `PlayInput` in shared/remotePlay.ts.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum PlayInput {
    Tap { x: f64, y: f64 },
    Point { x: f64, y: f64 },
    Button { button: MouseButton, down: bool },
    Look { dx: i32, dy: i32 },
    Wheel { ticks: i32 },
    Press { key: String },
    Chat { text: String },
}

/// One step of what an input does, so it can be tested without touching the
/// real keyboard.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    MoveToGame { x: f64, y: f64 },
    MoveBy { dx: i32, dy: i32 },
    Button { button: MouseButton, down: bool },
    Wheel { delta: i32 },
    Key { code: u16, down: bool },
    Char { unit: u16 },
    Wait { ms: u64 },
}

/// The only keys a phone can press: the game's menu and its three cameras.
/// Everything else is refused. Walking is by clicking, not by keyboard.
fn virtual_key(key: &str) -> Option<u16> {
    Some(match key {
        "escape" => 0x1B,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        _ => return None,
    })
}

fn game_point(x: f64, y: f64) -> Result<(f64, f64), String> {
    if (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y) {
        Ok((x, y))
    } else {
        Err("point outside the game".to_string())
    }
}

/// Chat text. Line breaks and other control characters are dropped, because
/// Enter is a key of its own that the phone presses on purpose.
fn text_units(text: &str) -> Vec<u16> {
    let clean: String = text.chars().filter(|c| !c.is_control()).take(MAX_TEXT_CHARS).collect();
    clean.encode_utf16().collect()
}

pub fn actions_for(input: &PlayInput) -> Result<Vec<Action>, String> {
    let press = |key: &str| virtual_key(key).ok_or_else(|| "that key isn't available".to_string());
    Ok(match input {
        PlayInput::Tap { x, y } => {
            let (x, y) = game_point(*x, *y)?;
            vec![
                Action::MoveToGame { x, y },
                Action::Wait { ms: CLICK_SETTLE_MS },
                Action::Button { button: MouseButton::Left, down: true },
                Action::Wait { ms: CLICK_HOLD_MS },
                Action::Button { button: MouseButton::Left, down: false },
            ]
        }
        PlayInput::Point { x, y } => {
            let (x, y) = game_point(*x, *y)?;
            vec![Action::MoveToGame { x, y }]
        }
        PlayInput::Button { button, down } => vec![Action::Button { button: *button, down: *down }],
        PlayInput::Look { dx, dy } => {
            vec![Action::MoveBy { dx: (*dx).clamp(-MAX_LOOK, MAX_LOOK), dy: (*dy).clamp(-MAX_LOOK, MAX_LOOK) }]
        }
        PlayInput::Wheel { ticks } => {
            vec![Action::Wheel { delta: (*ticks).clamp(-MAX_WHEEL_TICKS, MAX_WHEEL_TICKS) * WHEEL_NOTCH }]
        }
        PlayInput::Press { key } => tap_key(press(key)?).to_vec(),
        PlayInput::Chat { text } => chat_actions(text),
    })
}

fn tap_key(code: u16) -> [Action; 3] {
    [Action::Key { code, down: true }, Action::Wait { ms: KEY_HOLD_MS }, Action::Key { code, down: false }]
}

/// The text goes into whichever box is active in the game, and Enter sends it.
/// Nothing to say means no keys.
fn chat_actions(text: &str) -> Vec<Action> {
    let units = text_units(text);
    if units.is_empty() {
        return Vec::new();
    }
    let mut actions: Vec<Action> = units.into_iter().map(|unit| Action::Char { unit }).collect();
    actions.push(Action::Wait { ms: KEY_HOLD_MS });
    actions.extend(tap_key(ENTER));
    actions
}

/// The mouse buttons held down right now, so a dropped connection can't leave
/// the camera grabbed. Keys are only ever tapped, so they can't stick.
#[derive(Debug, Default)]
pub struct Held {
    buttons: Vec<MouseButton>,
}

impl Held {
    pub fn note(&mut self, actions: &[Action]) {
        for action in actions {
            match *action {
                Action::Button { button, down: true } if !self.buttons.contains(&button) => self.buttons.push(button),
                Action::Button { button, down: false } => self.buttons.retain(|held| *held != button),
                _ => {}
            }
        }
    }

    pub fn release(&mut self) -> Vec<Action> {
        self.buttons.drain(..).map(|button| Action::Button { button, down: false }).collect()
    }
}

/// `value` of 0..1 across `length` pixels from `start`.
pub fn pixel(start: i32, length: i32, value: f64) -> i32 {
    start + (f64::from(length.max(1) - 1) * value).round() as i32
}

/// A screen pixel in SendInput's 0..65535 span of the whole desktop.
pub fn absolute(position: i32, origin: i32, span: i32) -> i32 {
    let span = span.max(2);
    ((i64::from(position - origin) * 65535) / i64::from(span - 1)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(json: &str) -> PlayInput {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn only_the_game_keys_exist() {
        for key in ["escape", "f5", "f6", "f7"] {
            assert!(virtual_key(key).is_some(), "{key}");
        }
        for key in ["lwin", "rwin", "win", "alt", "menu", "ctrl", "control", "tab", "f4", "delete", "shift", "enter", "w", "a", "s", "d", "up", "", "0x5B", "91"] {
            assert_eq!(virtual_key(key), None, "{key}");
        }
    }

    #[test]
    fn a_key_outside_the_list_is_refused_not_ignored() {
        assert!(actions_for(&input(r#"{"t":"press","key":"lwin"}"#)).is_err());
        assert!(actions_for(&input(r#"{"t":"press","key":"alt"}"#)).is_err());
    }

    #[test]
    fn every_input_the_phone_sends_parses() {
        for json in [
            r#"{"t":"tap","x":0.5,"y":0.5}"#,
            r#"{"t":"point","x":0.5,"y":0.5}"#,
            r#"{"t":"button","button":"right","down":true}"#,
            r#"{"t":"look","dx":12,"dy":-3}"#,
            r#"{"t":"wheel","ticks":-1}"#,
            r#"{"t":"press","key":"f7"}"#,
            r#"{"t":"chat","text":"hello"}"#,
        ] {
            assert!(actions_for(&input(json)).is_ok(), "{json}");
        }
    }

    #[test]
    fn unknown_input_kinds_do_not_parse() {
        for json in [
            r#"{"t":"shell","command":"calc"}"#,
            r#"{"t":"vk","code":91}"#,
            r#"{"t":"key","key":"w","down":true}"#,
            r#"{"t":"text","text":"raw typing"}"#,
            r#"{"t":"button","button":"middle","down":true}"#,
            r#"{"t":"tap","x":"0.5","y":0.5}"#,
            r#"{"x":0.5,"y":0.5}"#,
        ] {
            assert!(serde_json::from_str::<PlayInput>(json).is_err(), "{json}");
        }
    }

    #[test]
    fn points_stay_inside_the_game() {
        assert!(actions_for(&PlayInput::Tap { x: 0.0, y: 1.0 }).is_ok());
        for (x, y) in [(-0.1, 0.5), (0.5, 1.1), (f64::NAN, 0.5), (0.5, f64::INFINITY)] {
            assert!(actions_for(&PlayInput::Tap { x, y }).is_err(), "{x} {y}");
            assert!(actions_for(&PlayInput::Point { x, y }).is_err(), "{x} {y}");
        }
    }

    #[test]
    fn a_tap_moves_then_clicks_slowly_enough_for_unity_to_see() {
        let actions = actions_for(&input(r#"{"t":"tap","x":0.25,"y":0.75}"#)).unwrap();
        assert_eq!(actions[0], Action::MoveToGame { x: 0.25, y: 0.75 });
        assert_eq!(actions[2], Action::Button { button: MouseButton::Left, down: true });
        assert_eq!(actions[4], Action::Button { button: MouseButton::Left, down: false });
        assert!(matches!(actions[3], Action::Wait { ms } if ms >= 34), "at least one 30 fps frame");
    }

    #[test]
    fn huge_moves_are_clamped() {
        assert_eq!(
            actions_for(&PlayInput::Look { dx: i32::MAX, dy: i32::MIN }).unwrap(),
            vec![Action::MoveBy { dx: MAX_LOOK, dy: -MAX_LOOK }]
        );
        assert_eq!(actions_for(&PlayInput::Wheel { ticks: 1000 }).unwrap(), vec![Action::Wheel { delta: MAX_WHEEL_TICKS * WHEEL_NOTCH }]);
    }

    #[test]
    fn text_can_not_press_enter_or_run_long() {
        assert_eq!(text_units("hi\r\nthere\t\u{1b}"), "hithere".encode_utf16().collect::<Vec<_>>());
        assert_eq!(text_units(&"x".repeat(MAX_TEXT_CHARS + 50)).len(), MAX_TEXT_CHARS);
        assert_eq!(text_units("héllo 😀").len(), "héllo 😀".encode_utf16().count());
    }

    #[test]
    fn chat_types_into_the_active_box_then_sends() {
        let actions = actions_for(&input(r#"{"t":"chat","text":"hi"}"#)).unwrap();
        let keys: Vec<&Action> = actions.iter().filter(|action| matches!(action, Action::Key { .. })).collect();
        assert_eq!(keys.len(), 2, "Enter down and up, once");
        assert_eq!(actions[0], Action::Char { unit: u16::from(b'h') }, "the text comes first");
        assert!(matches!(actions.last(), Some(Action::Key { code: ENTER, down: false })), "Enter comes last");
    }

    #[test]
    fn empty_chat_presses_nothing() {
        assert!(actions_for(&PlayInput::Chat { text: "\r\n\t".to_string() }).unwrap().is_empty());
        assert!(actions_for(&PlayInput::Chat { text: String::new() }).unwrap().is_empty());
    }

    #[test]
    fn a_held_button_is_released_exactly_once() {
        let mut held = Held::default();
        held.note(&[
            Action::Button { button: MouseButton::Left, down: true },
            Action::Button { button: MouseButton::Left, down: false },
            Action::Button { button: MouseButton::Right, down: true },
            Action::Button { button: MouseButton::Right, down: true },
        ]);
        assert_eq!(held.release(), vec![Action::Button { button: MouseButton::Right, down: false }]);
        assert!(held.release().is_empty());
    }

    #[test]
    fn a_game_point_maps_onto_the_whole_desktop() {
        // A 2560 wide game on the second of two monitors, the first 1920 wide.
        let span = 1920 + 2560;
        assert_eq!(pixel(1920, 2560, 0.0), 1920);
        assert_eq!(pixel(1920, 2560, 1.0), 1920 + 2559);
        assert_eq!(absolute(0, 0, span), 0);
        assert_eq!(absolute(span - 1, 0, span), 65535);
        // A monitor left of the primary gives the desktop a negative origin.
        assert_eq!(absolute(-1920, -1920, span), 0);
    }
}
