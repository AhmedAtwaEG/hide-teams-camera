# Hide Their Camera

Hide chosen people's camera video in Microsoft Teams meetings, on your screen only. Nobody else's view changes, and the person is not notified. Teams itself can only turn off *all* incoming video.

Their tile stays in place with their name and a "Camera hidden" label; audio, captions, reactions and their screen share are unaffected.

> Not affiliated with or endorsed by Microsoft. It relies on undocumented details of the Teams page and app, so a Teams update can break it.

Two ways to run the same `content.js`:

- **Teams web in Chrome**: the Chrome extension in this folder (below).
- **Teams desktop app on macOS**: the injector in [`desktop/`](desktop/) (see [Teams desktop app](#teams-desktop-app-macos)).

## Use

1. Click the extension's icon, enter the person's name as shown on their video tile (one per line), and press **Save**. Part of a name hides everyone whose name contains it; put the name in "quotes" to match it exactly. Saving takes effect immediately, even mid-call.
2. Join the meeting in Chrome with **Continue on this browser**. For the Teams desktop app, see [Teams desktop app](#teams-desktop-app-macos).
3. The Teams tab must be opened or reloaded after the extension was installed.

You can still right-click a hidden person's tile to pin them. Screen-share tiles are never marked, even though they carry the sharer's name.

## Install

```sh
git clone https://github.com/AhmedAtwaEG/hide-their-camera.git
```

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the cloned folder. Chrome loads the extension from this folder, so don't move or delete it. After editing a file, press the reload arrow on the extension's card.

## How it works

Teams web marks each remote participant's video tile like this (confirmed in a live meeting on 2026-11-11):

```html
<div data-cid="calling-participant-stream" data-tid="Display Name"
     data-stream-type="Video" role="menuitem"
     aria-label="Display Name, video is on, muted, …">
  <div data-tid="video-stream"><div data-tid="calling-stream"><video></video></div></div>
</div>
```

`data-tid` is usually the display name, but Teams sometimes fills it with a placeholder (`unknown_email_address@invalid.teams.ms` was seen on guest tiles after a rejoin). So the content script does not rely on it alone:

1. A `MutationObserver` reads each tile's name from the nametag (`[data-tid="participant-info-nametag"]`), the part of `aria-label` before the first comma, and `data-tid`, and sets `data-htc-hidden` on tiles that match a saved name.
2. CSS hides only the picture of marked tiles and labels them:

```css
[data-htc-hidden] video { visibility: hidden !important; }
[data-htc-hidden]:has(video)::after { content: "Camera hidden"; … }
```

3. The same CSS also lists direct attribute selectors per name (`[data-stream-type="video" i][data-tid*="name" i]`, and for quoted names `[aria-label^="name," i]`) as a fast path that applies before any script runs.

A quoted name must equal the tile's name; an unquoted one only has to be contained in it. Unquoted names get no `aria-label` CSS rule, because the label also contains words like "muted" and "pinned" that a short fragment would match. `data-stream-type` stays `"Video"` when the person's camera is off, so the `:has(video)` guard keeps the label off camera-off tiles. Your own self-view uses `data-tid="myself-video"` and is never matched.

Names and the on/off switch are stored in `chrome.storage.sync`. The content script runs on `teams.microsoft.com`, `teams.cloud.microsoft` and `teams.live.com`.

## Tested live (2026-11-11, Teams web in Chrome, guests joined from incognito windows)

- Single remote guest on stage: video hidden, captions still shown.
- Pin for me and Spotlight for everyone on the hidden person: stays hidden.
- Speaker view and Gallery view: stays hidden.
- Their camera turned off and on twice mid-call: never shown.
- Gallery with three guests: only the named one is hidden, the others stay visible.
- Changing the saved name mid-call: applies at once, no reload.
- Tiles whose `data-tid` is a placeholder: matched through the nametag instead.
- Exact (`"guest"`), partial (`guest 2`, `GUE`), mixed lists, a fragment that appears only in status words (`ed`), and the off switch all behave as expected.
- Reloaded v1.2.0 extension in a call with two guests: the exact-named guest is hidden with the "Camera hidden" label and name tag, the other stays visible.

The placeholder and name-variation rows were checked by running v1.2.0's script inside the live meeting page. In the call with the reloaded v1.2.0 extension, Teams happened to use real names in `data-tid`, so the installed extension has not itself met a placeholder tile yet. v1.1.0 failed on those: it matched on `data-tid` only.

## Not tested yet

- Large gallery (needs 10+ cameras), Together mode, Focus on content.
- The hidden person sharing their screen in Chrome (share tiles are excluded since 1.3.0; verified in the desktop app only).
- Real tenant display names such as "Last, First (Dept)".

## Ideas

- Toolbar badge showing whether anyone is currently being hidden.

## Teams desktop app (macOS)

New Teams for Mac (`com.microsoft.teams2`) is not Electron: it is a native shell around Microsoft's WebView2 (Edge/Chromium) that loads the same `teams.microsoft.com/v2` page, so the tile DOM and `content.js` are the same. Two differences, both found in a live call on 2026-11-11:

- **Getting the script in.** No extensions can be loaded, but when Teams is started with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=29229` its WebView serves the Chrome DevTools Protocol on `127.0.0.1:29229`. [`desktop/inject.mjs`](desktop/inject.mjs) (Node 22+, no dependencies) connects there, attaches to every Teams window including pop-out meeting windows, and runs `content.js` with `chrome.storage` replaced by [`desktop/names.txt`](desktop/names.txt).
- **How video is drawn.** The desktop app has no `<video>`: `[data-tid="calling-stream"]` is an empty, transparent box and the camera is drawn natively *under* the WebView, showing through it. Hiding or shrinking the box does nothing; giving it an opaque background covers the picture. `content.js` does that for marked tiles (harmless on the web, where the `<video>` is hidden anyway).

### Install

Needs Node.js 22 or newer.

```sh
cd hide-their-camera/desktop
./install.sh        # launch agent: runs inject.mjs at login, sets the WebView2 variable
```

Then quit Teams (Cmd+Q) and open it again once. Put names in `desktop/names.txt`, which `install.sh` creates from `names.example.txt` and git ignores (same rules as the popup; a line `off` turns it off). Saving the file applies within a second, even mid-call. Log: `~/Library/Logs/hide-teams-camera.log`. Remove with `./uninstall.sh`, then restart Teams.

If Teams is running without the port, cameras are **not** hidden. That happens after a reboot: Teams auto-starts before the agent has set the variable. The injector handles it:

- Teams started less than 2 minutes ago: it quits and reopens Teams with the port, silently (at most once per 10 minutes, so it can't loop).
- Teams has been running longer: it shows a "Restart Teams" dialog, because restarting would drop a call you're in.

What did not work: starting `MSTeams` directly from a shell (it quits and relaunches itself through LaunchServices, dropping the variable) and Teams' own `--remote-debugging-port` flag (not passed to the WebView). `open -a "Microsoft Teams" --env WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=...` and `launchctl setenv` both work.

### Security trade-off

While the variable is set, Teams' WebView accepts DevTools connections on `127.0.0.1:29229`. It is not reachable from the network, but any program running as you on this Mac could connect and act as you in Teams (read chats, tokens). The variable only affects WebView2 apps; Teams is the only one installed here. `uninstall.sh` removes it.

### Tested live (2026-11-11, Teams desktop 26276.505.5234.9924, WebView2 156, installed launch agent)

- Guest with camera on, speaker view: video replaced by "Camera hidden"; name tag and own self-view unaffected.
- Partial name (`GTC` for "GTC Guest") from `names.txt`.
- Hidden guest turns camera off and on again: stays hidden throughout.
- Second guest joins with camera on: only the named one is hidden, the other stays visible.
- Gallery and Speaker view, and the floating compact meeting window (it is content-protected, so it can't be screenshotted, but its tiles are marked the same).
- Hidden guest shares their screen: the share stays visible. The share is its own tile with the sharer's name in `data-tid` and `data-stream-type="ScreenSharing"`; it was marked hidden until `content.js` was changed to mark only camera tiles (this would have hidden their share in Chrome, where it is a `<video>`).
- Writing `off` into `names.txt` mid-call shows the video again; removing it hides it again within about 2 s.
- New meeting windows are picked up after they open. (An earlier version paused new windows until attached and froze the meeting window, "Debugger paused in another tab"; it now never pauses.)
- After a real reboot (2026-11-12) Teams auto-started a minute before the agent and ran without the port; the old notification-only warning went unnoticed. Now: a Teams started without the port is restarted once, about 14 s after launch, and hides cameras again about 18 s after launch; an older one gets the dialog, and choosing **Restart Teams** fixes it.
- Teams quit (Cmd+Q) and reopened from the Dock with the agent installed: the WebView came up with the port, and the agent reconnected and injected within about 6 s with no manual step.

Not tested yet on desktop: Teams updating itself mid-session, and Together mode / large gallery. The login fix was tested by launching Teams with the variable emptied, not yet through another reboot.

## License

[MIT](LICENSE)
