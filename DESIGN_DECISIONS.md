# Design Decisions: SS_GameLauncher

## Credits
Created by Termaine Jenkins (aka TJ, SENTIENT SOLUTIONS LLC)

---

### 2025-05-13: Initial Architecture
- **Decision:** Use a modular monolith structure with separate folders for backend (API server) and launcher-app (Electron desktop app).
- **Reason:** Easier to start, maintain, and refactor. Allows for future migration to microservices if needed.

### 2025-05-13: Keep Web Game Separate
- **Decision:** The web-based game will remain in its own folder/repo for now.
- **Reason:** Allows independent development and deployment. Integration will be via URL or API.

### 2025-05-13: Tech Stack Choices
- **Backend:** Node.js + Express + TypeScript
- **Launcher:** Electron (JavaScript)
- **Reason:** Popular, well-supported, and easy to maintain. TypeScript for type safety.

### 2025-05-13: Unified Start Command
- **Decision:** Use `concurrently` and a root-level `npm start` script to run backend and launcher-app together.
- **Reason:** Simplifies development workflow and reduces setup friction for developers. 