# SS_GameLauncher

**Created by Termaine Jenkins (aka TJ, SENTIENT SOLUTIONS LLC)**

## Overview
A modular game launcher for your UE4 game and web-based SPA game. Includes a backend API for news/updates and an Electron-based desktop launcher.

## Structure
- `backend/` - Node.js + Express API server (news, updates, etc.)
- `launcher-app/` - Electron desktop launcher (launches UE4 game, web game, shows news)

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