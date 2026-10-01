export async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!result.ok) {
    // Callback acknowledgements expire quickly. Redelivery must still update the menu.
    if (method === 'answerCallbackQuery' && result.error_code === 400 &&
      /query is too old|query ID is invalid|response timeout expired/i.test(result.description || '')) return null;
    // Tapping the already selected frequency or retrying an edit is a successful no-op.
    if (method === 'editMessageText' && result.error_code === 400 &&
      /message is not modified/i.test(result.description || '')) return null;
    throw Error(`Telegram ${method}: ${response.status} ${result.description}`);
  }
  return result.result;
}
