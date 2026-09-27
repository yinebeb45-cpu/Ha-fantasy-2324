/* =====================================================
   TELEGRAM WEBHOOK
===================================================== */

if (update.callback_query) {

  await handleCallback(
    update.callback_query
  );

  return res.status(200).json({
    ok: true
  });
}


/* =====================================================
   NORMAL TELEGRAM MESSAGE
===================================================== */

if (update.message) {

  const message = update.message;
  const chatId = String(message.chat?.id || '');
  const text = String(message.text || '').trim();

  console.log('Telegram message received:', {
    chatId,
    from: message.from?.id,
    text
  });

  /*
   * Only respond in the Ha Fantasy admin group.
   */
  if (chatId === ADMIN_CHAT_ID) {

    if (text === '/start') {

      await tg('sendMessage', {
        chat_id: chatId,
        text:
`🤖 Ha Fantasy Admin Bot

✅ Bot is connected
✅ Webhook is working
✅ Admin group detected

Wallet requests will appear here automatically.`
      });

    } else if (text.toLowerCase() === 'test ha fantasy') {

      await tg('sendMessage', {
        chat_id: chatId,
        text:
`✅ HA FANTASY BOT TEST PASSED

Telegram → Vercel → Telegram is working.`
      });

    }
  }

  return res.status(200).json({
    ok: true
  });
}
