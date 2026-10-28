/** Break @everyone / @here so a bug description cannot ping the channel. */
export function neutralizeMentions(text) {
  return String(text == null ? '' : text)
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@[&!]?\d+>/g, '[mention]');
}

export function discordPayload({ category, gameBuild, gpu, description, reportId, launcherVersion, developer, app, appVersion }) {
  const desc = neutralizeMentions(description).slice(0, 200);
  const lines = [`${developer ? '[DEV] ' : ''}Bug report ${reportId}`];
  if (app) {
    lines.push(`App: ${neutralizeMentions(app)} ${neutralizeMentions(appVersion || 'unknown')}`);
    lines.push(`Category: ${neutralizeMentions(category)}`);
  } else {
    lines.push(
      `Category: ${neutralizeMentions(category)}`,
      `Game build: ${neutralizeMentions(gameBuild || 'unknown')}`,
      `GPU: ${neutralizeMentions(gpu || 'unknown')}`,
      `Launcher: ${neutralizeMentions(launcherVersion || 'unknown')}`,
    );
  }
  const content = [...lines, '', desc].join('\n').slice(0, 1800);
  return {
    content,
    allowed_mentions: { parse: [] },
  };
}

export function safeError(err) {
  return String(err && err.message ? err.message : err).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 300);
}

/**
 * Posts the short note. Never throws the webhook URL. Returns { ok, skipped }.
 * Caller has already stored the report; a failure here must not roll that back.
 */
export async function notifyDiscord(webhookUrl, payload) {
  if (!webhookUrl) return { ok: false, skipped: true };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, skipped: false };
}
