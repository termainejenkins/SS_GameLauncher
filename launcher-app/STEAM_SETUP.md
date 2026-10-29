# Making Steam start the TGC Launcher

When this is set up, it works like The Division 2: the player presses **Play** in Steam, the TGC Launcher opens,
and the launcher's **PLAY** button starts the game from the same install folder.

Nothing below needs the terminal. Do every step on a **private beta branch** first. The default branch (what
players get) is changed only after the beta test passes.

---

## 1. What goes in the Steam depot (folder layout)

The launcher goes in a `Launcher` folder **inside** the packaged game folder (the `WindowsNoEditor` folder):

```
WindowsNoEditor\                      <- this whole folder is the depot content, same as today
  TheGreatCircle_4_27.exe             <- the game (unchanged)
  Engine\                             <- unchanged
  TheGreatCircle_4_27\                <- unchanged
  Launcher\                           <- NEW
    TGC_Launcher.exe                  <- Steam starts this
    launcher-config.json              <- tells the launcher where the game is
    resources\, locales\, *.dll, ...  <- the rest of the launcher, leave as is
```

How to make it:

1. Open File Explorer and go to the launcher's build folder: `launcher-app\dist\win-unpacked`.
2. Copy the `win-unpacked` folder.
3. Paste it inside the packaged game's `WindowsNoEditor` folder (for example
   `B:\EXT_UnrealExports\z_Desktop_A2\WindowsNoEditor`).
4. Rename the pasted folder from `win-unpacked` to `Launcher`.
5. Check: `WindowsNoEditor\Launcher\TGC_Launcher.exe` exists, and `TheGreatCircle_4_27.exe` is still next to the `Launcher` folder.
6. Do **not** add a `steam_appid.txt` anywhere. Steam supplies the app ID when it starts the launcher.

The launcher uses its own folder, so its DLLs never mix with the game's.

## 2. Test it on your PC first (optional)

1. Double-click `WindowsNoEditor\Launcher\TGC_Launcher.exe`. The launcher should open.
2. Click **PLAY**. The game should start, and the launcher window closes.
3. If you see "THE GREAT CIRCLE was not found next to the launcher", the `Launcher` folder is in the wrong place (see step 1).

Started this way, without Steam, the game's Steam features may not work. That's expected: they work when Steam starts the launcher.

## 3. Upload to a private beta branch

1. Upload the `WindowsNoEditor` folder (now with `Launcher` inside) the way you normally upload a build.
2. In Steamworks, go to **App Admin > SteamPipe > Builds**. If you don't already have a private beta branch, create one, for example `launcher-test`, and give it a password.
3. Set the new build live on `launcher-test` only. **Don't** set it live on `default`.

## 4. Add the launch option, beta branch only

In Steamworks, go to **App Admin > THE GREAT CIRCLE (1751950) > Installation > General Installation > Launch Options**.
Click **Add new launch option** and fill it in:

| Field | Value |
|---|---|
| Executable | `Launcher\TGC_Launcher.exe` |
| Arguments | *(leave empty)* |
| Description | `TGC Launcher` |
| Launch Type | Launch (Default) |
| Operating System | Windows |
| CPU Architecture | 64-bit only |
| Beta Key | `launcher-test` (so only that branch uses it) |

Click **Update**. Then open the **Publish** tab and publish the change. Steamworks changes don't apply until they're published.

Leave the existing launch option (the one that starts `TheGreatCircle_4_27.exe`) as it is for now.

## 5. Test the beta branch (from your Steam library)

1. In Steam, right-click THE GREAT CIRCLE, then choose **Properties > Betas**, and select `launcher-test` (enter the password).
2. Let Steam download the update, then press **Play**. If Steam asks which option to launch, pick **TGC Launcher**.
3. Check each of these:
   - [ ] The launcher opens with the SS icon in the taskbar.
   - [ ] **PLAY** starts the game, and the launcher window closes.
   - [ ] Steam keeps showing THE GREAT CIRCLE as **Running** while you play.
   - [ ] **Shift+Tab** opens the Steam overlay in the game.
   - [ ] Steam features in the game work (achievements, friends, multiplayer if used).
   - [ ] Discord unlocks show up in the game (the launcher refreshes them before starting the game).
   - [ ] After you quit the game, Steam shows it as stopped within a few seconds.
   - [ ] Double-clicking `TGC_Launcher.exe` while the launcher is already open only brings the open window to the front.

## 6. Go live (only after the beta passes)

1. Set the build live on `default`.
2. Edit the **existing default launch option** so its Executable is `Launcher\TGC_Launcher.exe`. Then delete the beta-only option, so players never get a "which one?" choice.
3. Publish.

## 7. The demo (app 1865070)

The demo is a separate app with its own depot and its own launch options. If you want the launcher in the demo too,
repeat steps 1 to 6 on the **demo** app (Steamworks > THE GREAT CIRCLE Demo > Installation > General Installation).
Use the demo's packaged folder and the same Executable `Launcher\TGC_Launcher.exe`. If you leave the demo alone, it keeps starting the game directly.

## 8. Rolling back

If anything goes wrong, change the launch option's Executable back to `TheGreatCircle_4_27.exe` and publish.
Players go straight back to the game. The `Launcher` folder can stay in the depot and does nothing on its own.

---

## Launcher settings (`Launcher\launcher-config.json`)

Open it in Notepad. Defaults:

```json
{
  "launchMode": "exe",
  "gameRoot": "..",
  "gameExe": ["TheGreatCircle_4_27.exe", "TheGreatCircle.exe",
              "TheGreatCircle_4_27/Binaries/Win64/TheGreatCircle_4_27-Win64-Shipping.exe"],
  "extraArgs": [],
  "forwardArgs": true,
  "afterLaunch": "close-and-wait",
  "startupCheckMs": 4000
}
```

- **gameRoot**: where the game is, relative to the launcher. `..` means one folder up, which matches the layout above.
- **gameExe**: the game exe names to look for, in order. The first one that exists is used. If the 5.x build gets a new exe name, add it here.
- **extraArgs**: arguments always passed to the game, for example `["-dx12"]`.
- **forwardArgs**: when this is on, anything a player types in Steam's *Launch Options* box (for example `-windowed`) is passed on to the game.
- **afterLaunch**: what the launcher does once the game is running:
  - `close-and-wait` (default): closes the window and waits quietly in the background until the game exits, then quits.
    This keeps Steam's "Running" status, playtime and overlay reliable.
  - `quit`: the launcher exits right after the game starts. This uses the least memory, but Steam may stop showing the game as running sooner.
  - `minimize`: the launcher stays open, minimized, and comes back when the game closes.
  - `stay`: the launcher stays open.
- **startupCheckMs**: if the game crashes within this many milliseconds, the launcher stays open and shows an error instead of closing.

## Building the launcher (for whoever builds it)

From the `launcher-app` folder, run `npm install`, then `npm run dist`, then `npm run dist:check`. The output is in `dist\win-unpacked`.

Before `npm run dist` (and before `npm run dist:installer`), supply the account-server and bug-report URLs. Copy `config.private.example.json` to `config.private.json` — that name is gitignored — and replace the placeholders, or export `ACCOUNT_SERVER_URL` and `BUG_REPORT_URL` in the same shell. The environment variable wins. The pack step writes those variables into the copy of `config.private.json` that is packed into the app, then puts your working tree back. If both are missing, the build still succeeds, but bug reports stay off and account-server calls fail the way they do when the server cannot be reached. `npm run dist:check` does not look for those URLs. Players only get this after a launcher release, which needs TJ's OK.
