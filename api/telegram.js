export default async function handler(req, res) {
  console.log("=== TELEGRAM WEBHOOK HIT ===");
  console.log("Method:", req.method);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // Always answer 200 quickly
  res.status(200).json({ ok: true });

  // Reply to the message if it exists
  try {
    const update = req.body;
    if (update?.message?.text) {
      const token = process.env.BOT_TOKEN;
      const chatId = update.message.chat.id;
      const text = update.message.text;

      console.log(`Replying to chat ${chatId}: ${text}`);

      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ Bot received: ${text}`,
        }),
      });

      const result = await response.json();
      console.log("Telegram sendMessage result:", result);
    }
  } catch (err) {
    console.error("Error while replying:", err);
  }
}
