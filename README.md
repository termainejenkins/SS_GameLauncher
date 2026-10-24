# SS_GameLauncher

**Created by Termaine Jenkins (aka TJ, SENTIENT SOLUTIONS LLC)**

## Overview
A modular game launcher for your UE4 game and web-based SPA game. Includes a backend API for news/updates and an Electron-based desktop launcher.

## Structure
- `backend/` - Node.js + Express API server (news, updates, etc.)
- `launcher-app/` - Electron desktop launcher (launches UE4 game, web game, shows news)
- `bug-report-worker/` - Cloudflare Worker that receives opt-in bug reports (not deployed yet)

## Report a bug

The launcher sidebar has **Report a bug**. The player writes a description, picks a category, and can attach a screenshot, the newest `TGC.log`, the latest crash folder, and a short system summary. A preview lists those files and the upload size. Nothing leaves the PC until they press **Send**.

Paths are scrubbed (`C:\Users\<name>\` becomes `C:\Users\<user>\`). The report is a zip of at most 25 MB posted to the Worker in `bug-report-worker/`, which stores it in a private R2 bucket and posts a short Discord note. Full deploy steps, rate limits, and the open TODOs are in [docs/bug-reports.md](docs/bug-reports.md).

```
npm test
```

## Setup

### Start Both Backend and Launcher Together
```
npm install # (at project root, to install concurrently)
npm start
```
This will start both the backend API server and the Electron launcher app in parallel.

### Backend (standalone)
```
cd backend
npm install
npm run dev
```

### Launcher App (standalone)
```
cd launcher-app
npm install
npm start
```

## Next Steps
- Integrate UE4 game launching logic
- Set web game URL in `renderer.js`
- Expand backend for updates, authentication, etc.

## Possible Next Features
- Game update/patch notifications
- User authentication (Steam, Google, email, etc.)
- Download/install management for non-Steam builds
- Enhanced news feed (images, links, markdown)
- User settings/preferences (theme, default launch method, saved URLs)
- Analytics/event tracking with user consent (launcher open, game launch, errors)
- In-app bug report form for user-submitted error reports
- UI/UX enhancements (modern design, dark/light mode)
- Web game embedding in the launcher
- Multi-language support
- Error reporting and troubleshooting tools
- Dark/Light mode toggle for user preference
- Version comparison and update prompt for game updates
- Enhanced news feed with support for images, links, and HTML formatting 