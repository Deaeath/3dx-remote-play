<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="120" alt="3DX Remote Play logo">
</p>

<h1 align="center">3DX Remote Play</h1>

<p align="center">
  <b>Play 3DXChat on your phone, from anywhere.</b><br>
  The game keeps running on your PC. Your phone becomes the screen and the controls.
</p>

<p align="center">
  <a href="https://github.com/Deaeath/3dx-remote-play/releases/latest"><img src="https://img.shields.io/github/v/release/Deaeath/3dx-remote-play?label=download" alt="Download"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4" alt="Windows 10 and 11">
</p>

---

## 📱 How does it work?

1. **Install** 3DX Remote Play on the PC you play on: grab the setup from the [latest release](https://github.com/Deaeath/3dx-remote-play/releases/latest).
2. **Turn on** Allow Remote Play and press **Show pairing code**.
3. **Scan** the code with your phone's camera and tap **Start playing**.

Next time, just open the page you saved. It works on Wi-Fi and on mobile data, with nothing to install on the phone and nothing to set up on your router.

**On iPhone:** for full screen, tap **Share → Add to Home Screen** *before* you start, then open **3DX Play** from your Home Screen. The pairing link works only once.

## 🎮 Controls

| On your phone | In the game |
|---|---|
| Tap | Walk there, or click |
| Drag | Turn the camera |
| Hold, then drag | Move sliders and windows |
| Pinch | Zoom |
| 💬 | Chat with your phone's keyboard |
| 📷 | Switch camera |
| ☰ | Game menu |
| 🔍 | Magnifier for small buttons |
| 🔊 | Sound on or off |
| ⏻ | End the session |

## 🔒 Private by design

- **Only the game.** Your phone sees the 3DXChat window and hears the game's sound. Nothing else on your PC.
- **Only game controls.** A phone can click inside the game, chat, and use a keyboard and controller made for it. No Windows, Alt or Ctrl keys, so no Alt+Tab, and all input stops the moment the game isn't in front.
- **One phone.** A pairing link works once, for 15 minutes. The first phone to open it gets a key of its own, and the link stops working.
- **Encrypted end to end.** Picture, sound and controls are encrypted between your PC and your phone. They go straight between the two when they can, and through a Cloudflare relay when they can't. Cloudflare only ever sees sealed data.
- **You'll know.** Your PC shows a notification whenever a phone connects.

## 💡 Good to know

- Keep the PC on, signed in and unlocked. While Remote Play is on, the PC won't go to sleep.
- 3DXChat has to be open, or start it from your phone once it has run on this PC.
- Closing the window keeps Remote Play running in the tray. **Open with Windows** makes the PC ready again after a restart.
- It works with a VPN on, on your PC or your phone.
- Your phone types into whichever chat box is active in the game, so tap the one you want first.
- If your phone won't connect, the page shows which step it's on, and the app writes what happened to `remote_play.log` in `%APPDATA%\com.kingcolossus.remoteplay`. It holds no addresses or keys, and it stays on your PC.
- Windows may say the app is from an unknown publisher: click **More info**, then **Run anyway**.

<details>
<summary><b>🛠️ For developers</b></summary>

- `src/`: the app's window and the host that runs WebRTC.
- `src-tauri/`: the native side: finding the game, game-only sound, and the input rules in `remote_input.rs`.
- `shared/`: the protocol both ends speak.
- `phone/`: the phone page (Cloudflare Pages) and the relay (a Worker with a Durable Object).

```powershell
npm install
npm run tauri dev       # run the app
npm test                # protocol, controls, relay and host tests
npm run tauri build     # the installer
npm run deploy:phone    # the phone page and the relay
```

**TURN.** Some mobile carriers and VPNs block direct connections, so a copy of the page needs its own relay. Create a TURN key (not an SFU app) under Realtime in the Cloudflare dashboard, then set it on the Pages project:

```powershell
npx wrangler pages secret put TURN_KEY_ID --project-name 3dx-play
npx wrangler pages secret put TURN_KEY_TOKEN --project-name 3dx-play
```

**Moving the phone page.** Its address is in `shared/remotePlay.ts` (`PLAY_ORIGIN`), the `connect-src` of `src-tauri/tauri.conf.json` and `phone/web/public/_headers`.

</details>

---

<p align="center">By KingColossus · MIT License</p>
