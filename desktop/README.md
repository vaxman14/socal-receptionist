# SoCal Receptionist — Desktop

Electron tray app for time tracking. Lives in the system tray, no dock icon.

## Setup

```bash
cd desktop
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_ANON_KEY, TENANT_ID in .env
npm install
```

## Run (dev)

```bash
npm start
```

Global hotkey `Cmd+Shift+T` (macOS) / `Ctrl+Shift+T` (Windows) opens the Quick Log floating window.

## Build

```bash
# macOS DMG
npm run build:mac

# Windows NSIS installer
npm run build:win
```

Distributable output is written to `dist/`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `TENANT_ID` | Recommended | Filters realtime subscription to your tenant |
| `USER_ACCESS_TOKEN` | Optional | User JWT for row-level security |

## Screen-time tracker

Every 60 seconds the app records the active app name and window title to `~/.socal-desktop/activity-log.json`. Click any entry in the Quick Log window to use it as a time entry description.
