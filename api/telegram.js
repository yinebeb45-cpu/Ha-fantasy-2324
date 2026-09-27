// Temporary debug handler – replace your current telegram route with this
export default async function handler(req, res) {
  console.log("=== TELEGRAM WEBHOOK HIT ===");
  console.log("Method:", req.method);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // Always answer 200 quickly so Telegram doesn’t retry
  res.status(200).json({ ok: true });

  // Optional: simple echo (only if you want to test reply)
  /*
  if (req.body?.message?.text) {
    const token = process.env.BOT_TOKEN;
    const chatId = req.body.message.chat.id;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Received: ${req.body.message.text}`,
      }),
    });
  }
  */
}
