/**
 * Ha Fantasy — Deposit / Withdrawal admin bot
 *
 * SETUP:
 * 1. npm install
 * 2. Set BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY below
 * 3. Add the bot to your admin group as admin
 * 4. node ha-fantasy-bot.js  (or use pm2 / Railway / Render)
 *
 * Mini App must open via Bot Menu Button or Keyboard web_app button
 * so Telegram.WebApp.sendData reaches this bot.
 */

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// ========== CONFIG — FILL THESE ==========
const BOT_TOKEN = process.env.BOT_TOKEN || '8890048280:AAGf37kga07bxj2Oco6wobNrKOpDAOmrRAE';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '-1004468798532'; // your group
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ddnznnflhtsiztlhuooc.supabase.co';
// Use SERVICE ROLE key (Settings → API → service_role) — never put this in the Mini App HTML
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'sb_secret_SssVr1l_z8TsbzbJNL33Jw_wM9vvzzO';
// =========================================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log('🚀 Ha Fantasy Bot online. Admin group:', ADMIN_CHAT_ID);

async function getOrCreateWallet(telegramId, userName) {
  const tid = String(telegramId);
  const { data } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('telegram_id', tid)
    .maybeSingle();

  if (data) return data;

  const row = {
    telegram_id: tid,
    user_name: userName || 'Manager',
    balance: 0,
    total_deposits: 0,
    total_withdrawals: 0,
    total_winnings: 0
  };
  const { data: created, error } = await supabase
    .from('user_wallets')
    .upsert(row, { onConflict: 'telegram_id' })
    .select()
    .maybeSingle();
  if (error) console.error('create wallet', error.message);
  return created || row;
}

async function creditDeposit(telegramId, amount, userName) {
  const amt = Number(amount) || 0;
  if (amt <= 0) throw new Error('Invalid amount');
  const wallet = await getOrCreateWallet(telegramId, userName);
  const balance = Number(wallet.balance || 0) + amt;
  const total_deposits = Number(wallet.total_deposits || 0) + amt;
  const { error } = await supabase
    .from('user_wallets')
    .upsert({
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
  const { error } = await supabase
    .from('user_wallets')
    .upsert({
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
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const un = user.username ? `@${user.username}` : 'N/A';
  return `${name} (${un})`;
}

// ----- WebApp data (deposit / withdraw from Mini App) -----
bot.on('message', async (msg) => {
  if (!msg.web_app_data) return;

  const chatId = msg.chat.id;
  const user = msg.from;

  try {
    const data = JSON.parse(msg.web_app_data.data);

    if (data.type === 'DEPOSIT_SUBMISSION') {
      const amount = data.amount;
      const receipt = data.receipt || '';
      const notice =
        `🚨 *NEW DEPOSIT REQUEST*\n\n` +
        `👤 *User:* ${userLabel(user)}\n` +
        `🆔 *Telegram ID:* \`${user.id}\`\n` +
        `💵 *Amount:* *${amount} ETB*\n\n` +
        `📜 *Telebirr SMS / Receipt:*\n\`\`\`\n${String(receipt).slice(0, 900)}\n\`\`\``;

      await bot.sendMessage(ADMIN_CHAT_ID, notice, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve Deposit', callback_data: `approve_dep_${user.id}_${amount}` },
            { text: '❌ Reject', callback_data: `reject_dep_${user.id}_0` }
          ]]
        }
      });

      await bot.sendMessage(
        chatId,
        '✅ Deposit request sent to management.\nBalance is credited only after approval.'
      );
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

      await bot.sendMessage(ADMIN_CHAT_ID, notice, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Mark Paid', callback_data: `paid_wit_${user.id}_${amount}` },
            { text: '❌ Reject', callback_data: `reject_wit_${user.id}_0` }
          ]]
        }
      });

      await bot.sendMessage(chatId, '💸 Withdrawal request received. We will process it shortly.');
    }
  } catch (err) {
    console.error('web_app_data error:', err);
    try {
      await bot.sendMessage(chatId, '⚠️ Could not process your request. Try again or contact support.');
    } catch (e) {}
  }
});

// ----- Admin buttons -----
bot.on('callback_query', async (query) => {
  try {
    const parts = (query.data || '').split('_');
    // approve_dep_USERID_AMOUNT  | reject_dep_USERID_0 | paid_wit_USERID_AMOUNT | reject_wit_USERID_0
    const action = parts[0];
    const type = parts[1];
    const userId = parts[2];
    const amount = parts[3];

    if (action === 'approve' && type === 'dep') {
      try {
        const newBal = await creditDeposit(userId, amount, query.message?.text?.match(/User:/)?.input);
        await bot.answerCallbackQuery(query.id, { text: 'Deposit approved & wallet credited' });
        await bot.sendMessage(
          userId,
          `🎉 Your deposit of *${amount} ETB* was approved!\nNew balance: *${newBal} ETB*\nOpen Ha Fantasy to join contests.`,
          { parse_mode: 'Markdown' }
        );
        await bot.editMessageText(
          (query.message.text || '') + `\n\n✅ *STATUS: APPROVED* (+${amount} ETB)`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
        );
      } catch (e) {
        console.error(e);
        await bot.answerCallbackQuery(query.id, { text: 'DB error: ' + (e.message || e), show_alert: true });
      }
      return;
    }

    if (action === 'reject' && type === 'dep') {
      await bot.answerCallbackQuery(query.id, { text: 'Deposit rejected' });
      try {
        await bot.sendMessage(userId, '❌ Your deposit could not be verified. Please contact support with your receipt.');
      } catch (e) {}
      await bot.editMessageText(
        (query.message.text || '') + '\n\n❌ *STATUS: REJECTED*',
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      return;
    }

    if (action === 'paid' && type === 'wit') {
      try {
        // Debit only when marking paid (money left the wallet)
        const newBal = await debitWithdrawal(userId, amount);
        await bot.answerCallbackQuery(query.id, { text: 'Marked paid — wallet debited' });
        await bot.sendMessage(
          userId,
          `🎉 Withdrawal of *${amount} ETB* sent!\nRemaining balance: *${newBal} ETB*`,
          { parse_mode: 'Markdown' }
        );
        await bot.editMessageText(
          (query.message.text || '') + `\n\n✅ *STATUS: PAID OUT* (−${amount} ETB)`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
        );
      } catch (e) {
        console.error(e);
        await bot.answerCallbackQuery(query.id, { text: 'Error: ' + (e.message || e), show_alert: true });
      }
      return;
    }

    if (action === 'reject' && type === 'wit') {
      await bot.answerCallbackQuery(query.id, { text: 'Withdrawal rejected' });
      try {
        await bot.sendMessage(userId, '❌ Your withdrawal request was rejected. Contact support if needed.');
      } catch (e) {}
      await bot.editMessageText(
        (query.message.text || '') + '\n\n❌ *STATUS: REJECTED*',
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      return;
    }
  } catch (err) {
    console.error('callback error', err);
    try {
      await bot.answerCallbackQuery(query.id, { text: 'Error processing action', show_alert: true });
    } catch (e) {}
  }
});

bot.on('polling_error', (err) => console.error('polling_error', err.message || err));
