#!/bin/sh
# Removes the launch agent and the session variable. Quit and reopen Teams afterwards to
# close its DevTools port.
LABEL=com.hide-teams-camera.inject
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unsetenv WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
echo "Uninstalled. Quit Teams (Cmd+Q) and open it again to close its debugging port."
