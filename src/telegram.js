// Minimal Telegram Bot API client for one-way notifications to Roman/Josi.
// Uses the bot already paired with chat 6335227029 (Roman's Telegram DM).
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  (required to enable)
//   TELEGRAM_CHAT_ID    (defaults to Roman's chat ID)
//
// If TELEGRAM_BOT_TOKEN is unset, sendTelegram() becomes a no-op so the
// rest of the app keeps working without a hard dependency.

const TELEGRAM_API = 'https://api.telegram.org';

async function sendTelegram(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (!token) console.warn('TELEGRAM_BOT_TOKEN unset — skipping Telegram notification');
    if (!chatId) console.warn('TELEGRAM_CHAT_ID unset — skipping Telegram notification');
    return { ok: false, skipped: true };
  }

  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
  return res.json();
}

module.exports = { sendTelegram };
