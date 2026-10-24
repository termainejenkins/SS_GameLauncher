// Shared caps. Keep ZIP_MAX_BYTES and the description bounds in sync with launcher-app/bug-report.js.
export const ZIP_MAX_BYTES = 25 * 1024 * 1024;
// Screenshot rides beside the zip, so the body cap is the zip cap plus this allowance and a little multipart overhead.
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const BODY_OVERHEAD_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = ZIP_MAX_BYTES + SCREENSHOT_MAX_BYTES + BODY_OVERHEAD_BYTES;
export const DESC_MIN = 20;
export const DESC_MAX = 2000;
export const CATEGORIES = Object.freeze(['crash', 'performance', 'gameplay', 'other']);
export const INSTALL_LIMIT = 5;
export const IP_LIMIT = 20;
export const RETENTION_DAYS = 90;
// How many days past the retention window the daily cron still walks. The R2 lifecycle rule covers anything older.
export const RETENTION_LOOKBACK_DAYS = 120;
export const DAY_MS = 24 * 60 * 60 * 1000;
