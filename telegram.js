const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '-1004468798532';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

function supabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

async function tg(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function getOrCreateWallet(telegramId, userName) {
  const sb = supabase();
  const tid = String(telegramId);
  const { data } = await sb.from('user_wallets').select('*').eq('telegram_id', tid).maybeSingle();
  if (data) return data;
  const row = {
    telegram_id: tid,
    user_name: userName || 'Manager',
    balance: 0,
    total_deposits: 0,
    total_withdrawals: 0,
    total_winnings: 0
  };
  await sb.from('user_wallets').upsert(row, { onConflict: 'telegram_id' });
  return row;
}

async function creditDeposit(telegramId, amount, userName) {
  const amt = Number(amount) || 0;
  if (amt <= 0) throw new Error('Invalid amount');
  const wallet = await getOrCreateWallet(telegramId, userName);
  const balance = Number(wallet.balance || 0) + amt;
  const total_deposits = Number(wallet.total_deposits || 0) + amt;
  const { error } = await supabase().from('user_wallets').upsert({
    telegram_id: String(telegramId),
    user_name: userName || wallet.user_name,
    balance,
    total_deposits,
    total_withdrawals: wallet.total_withdrawals || 0,
    total_winnings: wallet.total_winnings || 0,
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' });
  if (error) throw error;
  return balance;
}

async function debitWithdrawal(telegramId, amount) {
  const amt = Number(amount) || 0;
  if (amt <= 0) throw new Error('Invalid amount');
  const wallet = await getOrCreateWallet(telegramId);
  const bal = Number(wallet.balance || 0);
  if (bal < amt) throw new Error('Insufficient balance');
  const balance = bal - amt;
  const total_withdrawals = Number(wallet.total_withdrawals || 0) + amt;
  const { error } = await supabase().from('user_wallets').upsert({
    telegram_id: String(telegramId),
    user_name: wallet.user_name,
    balance,
    total_deposits: wallet.total_deposits || 0,
    total_withdrawals,
    total_winnings: wallet.total_winnings || 0,
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' });
  if (error) throw error;
  return balance;
}

function userLabel(user) {
  if (!user) return 'Unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const un = user.username ? `@${user.username}` : 'N/A';
  return `${name} (${un})`;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Ha Fantasy bot webhook OK');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const update = req.body;

    // ---- WebApp data (deposit / withdraw) ----
    if (update.message && update.message.web_app_data) {
      const msg = update.message;
      const user = msg.from;
      const chatId = msg.chat.id;
      let data;
      try {
        data = JSON.parse(msg.web_app_data.data);
      } catch (e) {
        return res.status(200).json({ ok: true });
      }

      if (data.type === 'DEPOSIT_SUBMISSION') {
        const amount = data.amount;
        const receipt = data.receipt || '';
        const notice =
          `🚨 *NEW DEPOSIT REQUEST*\n\n` +
          `👤 *User:* ${userLabel(user)}\n` +
          `🆔 *Telegram ID:* \`${user.id}\`\n` +
          `💵 *Amount:* *${amount} ETB*\n\n` +
          `📜 *Telebirr SMS / Receipt:*\n\`\`\`\n${String(receipt).slice(0, 900)}\n\`\`\``;

        await tg('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text: notice,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve Deposit', callback_data: `approve_dep_${user.id}_${amount}` },
              { text: '❌ Reject', callback_data: `reject_dep_${user.id}_0` }
            ]]
          }
        });
        await tg('sendMessage', {
          chat_id: chatId,
          text: '✅ Deposit request sent to management.\nBalance is credited only after approval.'
        });
      }

      if (data.type === 'WITHDRAWAL_REQUEST') {
        const amount = data.amount;
        const method = (data.method || 'telebirr').toUpperCase();
        const notice =
          `💸 *NEW WITHDRAWAL REQUEST*\n\n` +
          `👤 *User:* ${userLabel(user)}\n` +
          `🆔 *Telegram ID:* \`${user.id}\`\n` +
          `💵 *Amount:* *${amount} ETB*\n` +
          `🏦 *Method:* ${method}\n` +
          `👤 *Account Name:* ${data.accountName || '—'}\n` +
          `🔢 *Account/Phone:* \`${data.accountNo || '—'}\``;

        await tg('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text: notice,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Mark Paid', callback_data: `paid_wit_${user.id}_${amount}` },
              { text: '❌ Reject', callback_data: `reject_wit_${user.id}_0` }
            ]]
          }
        });
        await tg('sendMessage', {
          chat_id: chatId,
          text: '💸 Withdrawal request received. We will process it shortly.'
        });
      }

      return res.status(200).json({ ok: true });
    }

    // ---- Admin button callbacks ----
    if (update.callback_query) {
      const query = update.callback_query;
      const parts = (query.data || '').split('_');
      const action = parts[0];
      const type = parts[1];
      const userId = parts[2];
      const amount = parts[3];

      if (action === 'approve' && type === 'dep') {
        try {
          const newBal = await creditDeposit(userId, amount);
          await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Deposit approved' });
          await tg('sendMessage', {
            chat_id: userId,
            text: `🎉 Your deposit of *${amount} ETB* was approved!\nNew balance: *${newBal} ETB*`,
            parse_mode: 'Markdown'
          });
          await tg('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: (query.message.text || '') + `\n\n✅ STATUS: APPROVED (+${amount} ETB)`
          });
        } catch (e) {
          await tg('answerCallbackQuery', {
            callback_query_id: query.id,
            text: 'Error: ' + (e.message || e),
            show_alert: true
          });
        }
      }

      if (action === 'reject' && type === 'dep') {
        await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Rejected' });
        await tg('sendMessage', {
          chat_id: userId,
          text: '❌ Your deposit could not be verified. Please contact support.'
        });
        await tg('editMessageText', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: (query.message.text || '') + '\n\n❌ STATUS: REJECTED'
        });
      }

      if (action === 'paid' && type === 'wit') {
        try {
          const newBal = await debitWithdrawal(userId, amount);
          await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Marked paid' });
          await tg('sendMessage', {
            chat_id: userId,
            text: `🎉 Withdrawal of *${amount} ETB* sent!\nRemaining balance: *${newBal} ETB*`,
            parse_mode: 'Markdown'
          });
          await tg('editMessageText', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: (query.message.text || '') + `\n\n✅ STATUS: PAID OUT (−${amount} ETB)`
          });
        } catch (e) {
          await tg('answerCallbackQuery', {
            callback_query_id: query.id,
            text: 'Error: ' + (e.message || e),
            show_alert: true
          });
        }
      }

      if (action === 'reject' && type === 'wit') {
        await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Rejected' });
        await tg('sendMessage', {
          chat_id: userId,
          text: '❌ Your withdrawal request was rejected.'
        });
        await tg('editMessageText', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: (query.message.text || '') + '\n\n❌ STATUS: REJECTED'
        });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true }); // always 200 so Telegram doesn't retry forever
  }
};
