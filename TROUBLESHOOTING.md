# Troubleshooting: SS_GameLauncher

## Credits
Created by Termaine Jenkins (aka TJ, SENTIENT SOLUTIONS LLC)

---

### 2025-05-13: PowerShell mkdir Error
- **Bug:** `mkdir backend launcher-app` failed in PowerShell due to invalid argument.
- **Resolution:** Ran `mkdir backend` and `mkdir launcher-app` separately.

### 2025-05-13: PowerShell Command Separator
- **Bug:** `cd backend && npm init -y` failed in PowerShell due to invalid statement separator.
- **Resolution:** Used `cd backend; npm init -y` instead. 