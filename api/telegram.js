const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '-1004468798532');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
  );
}

async function telegram(method, body) {
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is missing');
  }

  const response = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      `Telegram ${method} failed: ${result.description || 'Unknown error'}`
    );
  }

  return result;
}

/* =========================================================
   WALLET
========================================================= */

async function getWallet(telegramId, userName = 'Manager') {
  const sb = getSupabase();
  const id = String(telegramId);

  const { data, error } = await sb
    .from('user_wallets')
    .select('*')
    .eq('telegram_id', id)
    .maybeSingle();

  if (error) throw error;

  if (data) return data;

  const wallet = {
    telegram_id: id,
    user_name: userName || 'Manager',
    balance: 0,
    total_deposits: 0,
    total_withdrawals: 0,
    total_winnings: 0
  };

  const { data: created, error: createError } = await sb
    .from('user_wallets')
    .upsert(wallet, {
      onConflict: 'telegram_id'
    })
    .select()
    .single();

  if (createError) throw createError;

  return created;
}


/* =========================================================
   DEPOSIT
========================================================= */

async function approveDeposit(telegramId, amount, userName) {
  const sb = getSupabase();
  const id = String(telegramId);
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('Invalid deposit amount');
  }

  const wallet = await getWallet(id, userName);

  const newBalance =
    Number(wallet.balance || 0) + amt;

  const newTotalDeposits =
    Number(wallet.total_deposits || 0) + amt;

  const { error } = await sb
    .from('user_wallets')
    .update({
      user_name: userName || wallet.user_name,
      balance: newBalance,
      total_deposits: newTotalDeposits,
      updated_at: new Date().toISOString()
    })
    .eq('telegram_id', id);

  if (error) throw error;

  return newBalance;
}


/* =========================================================
   WITHDRAWAL
========================================================= */

async function approveWithdrawal(telegramId, amount) {
  const sb = getSupabase();
  const id = String(telegramId);
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('Invalid withdrawal amount');
  }

  const wallet = await getWallet(id);

  const currentBalance =
    Number(wallet.balance || 0);

  if (currentBalance < amt) {
    throw new Error(
      `Insufficient balance. Current balance: ${currentBalance} ETB`
    );
  }

  const newBalance =
    currentBalance - amt;

  const newTotalWithdrawals =
    Number(wallet.total_withdrawals || 0) + amt;

  const { error } = await sb
    .from('user_wallets')
    .update({
      balance: newBalance,
      total_withdrawals: newTotalWithdrawals,
      updated_at: new Date().toISOString()
    })
    .eq('telegram_id', id);

  if (error) throw error;

  return newBalance;
}


/* =========================================================
   USER DISPLAY
========================================================= */

function userLabel(user) {
  if (!user) return 'Unknown';

  const name = [
    user.first_name,
    user.last_name
  ]
    .filter(Boolean)
    .join(' ');

  const username = user.username
    ? `@${user.username}`
    : 'N/A';

  return `${name || 'Unknown'} (${username})`;
}


/* =========================================================
   WEBHOOK
========================================================= */

module.exports = async function handler(req, res) {

  /* Health check */
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Ha Fantasy Telegram Backend',
      status: 'online'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {

    const update = req.body || {};

    /* =====================================================
       WEB APP DATA
    ===================================================== */

    if (
      update.message &&
      update.message.web_app_data
    ) {

      const message = update.message;
      const user = message.from;

      let data;

      try {
        data = JSON.parse(
          message.web_app_data.data
        );
      } catch (error) {

        console.error(
          'Invalid WebApp JSON:',
          error
        );

        return res.status(200).json({
          ok: true
        });
      }


      /* ===================================================
         DEPOSIT REQUEST
      =================================================== */

      if (data.type === 'DEPOSIT_SUBMISSION') {

        const amount = Number(data.amount);
        const receipt = String(
          data.receipt || ''
        );

        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(200).json({
            ok: true
          });
        }

        const notice =
          `🚨 *NEW DEPOSIT REQUEST*\n\n` +
          `👤 *User:* ${userLabel(user)}\n` +
          `🆔 *Telegram ID:* \`${user.id}\`\n` +
          `💵 *Amount:* *${amount} ETB*\n\n` +
          `📜 *Telebirr SMS / Receipt:*\n` +
          '```\n' +
          `${receipt.slice(0, 900)}` +
          '\n```';

        await telegram('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text: notice,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: '✅ Approve Deposit',
                callback_data:
                  `approve_dep_${user.id}_${amount}`
              },
              {
                text: '❌ Reject',
                callback_data:
                  `reject_dep_${user.id}_${amount}`
              }
            ]]
          }
        });

        await telegram('sendMessage', {
          chat_id: user.id,
          text:
            '✅ Deposit request sent to management.\n\n' +
            'Your balance will be credited after approval.'
        });
      }


      /* ===================================================
         WITHDRAWAL REQUEST
      =================================================== */

      if (data.type === 'WITHDRAWAL_REQUEST') {

        const amount = Number(data.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(200).json({
            ok: true
          });
        }

        const method =
          String(
            data.method || 'telebirr'
          ).toUpperCase();

        const accountName =
          String(
            data.accountName || '—'
          );

        const accountNo =
          String(
            data.accountNo || '—'
          );

        const notice =
          `💸 *NEW WITHDRAWAL REQUEST*\n\n` +
          `👤 *User:* ${userLabel(user)}\n` +
          `🆔 *Telegram ID:* \`${user.id}\`\n` +
          `💵 *Amount:* *${amount} ETB*\n` +
          `🏦 *Method:* ${method}\n` +
          `👤 *Account Name:* ${accountName}\n` +
          `🔢 *Account/Phone:* \`${accountNo}\``;

        await telegram('sendMessage', {
          chat_id: ADMIN_CHAT_ID,
          text: notice,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: '✅ Mark Paid',
                callback_data:
                  `paid_wit_${user.id}_${amount}`
              },
              {
                text: '❌ Reject',
                callback_data:
                  `reject_wit_${user.id}_${amount}`
              }
            ]]
          }
        });

        await telegram('sendMessage', {
          chat_id: user.id,
          text:
            '💸 Withdrawal request received.\n\n' +
            'Management will process it shortly.'
        });
      }

      return res.status(200).json({
        ok: true
      });
    }


    /* =====================================================
       ADMIN BUTTON CALLBACKS
    ===================================================== */

    if (update.callback_query) {

      const query = update.callback_query;

      /*
       * SECURITY:
       * Only callbacks originating from the configured
       * admin chat can approve/reject wallet requests.
       */

      const callbackChatId =
        String(
          query.message?.chat?.id || ''
        );

      if (callbackChatId !== ADMIN_CHAT_ID) {

        await telegram('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Unauthorized',
          show_alert: true
        });

        return res.status(200).json({
          ok: true
        });
      }

      const parts =
        String(query.data || '').split('_');

      const action = parts[0];
      const type = parts[1];
      const userId = parts[2];
      const amount = parts[3];

      if (!userId || !amount) {

        await telegram('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Invalid request',
          show_alert: true
        });

        return res.status(200).json({
          ok: true
        });
      }


      /* ===================================================
         APPROVE DEPOSIT
      =================================================== */

      if (
        action === 'approve' &&
        type === 'dep'
      ) {

        try {

          const newBalance =
            await approveDeposit(
              userId,
              amount
            );

          await telegram(
            'answerCallbackQuery',
            {
              callback_query_id: query.id,
              text: 'Deposit approved ✅'
            }
          );

          await telegram(
            'sendMessage',
            {
              chat_id: userId,
              text:
                `🎉 Your deposit of *${amount} ETB* was approved!\n\n` +
                `💰 New balance: *${newBalance} ETB*`,
              parse_mode: 'Markdown'
            }
          );

          await telegram(
            'editMessageText',
            {
              chat_id:
                query.message.chat.id,

              message_id:
                query.message.message_id,

              text:
                `${query.message.text || ''}` +
                `\n\n✅ STATUS: APPROVED (+${amount} ETB)`,

              parse_mode: 'Markdown'
            }
          );

        } catch (error) {

          console.error(error);

          await telegram(
            'answerCallbackQuery',
            {
              callback_query_id: query.id,
              text:
                `Error: ${error.message}`,
              show_alert: true
            }
          );
        }

        return res.status(200).json({
          ok: true
        });
      }


      /* ===================================================
         REJECT DEPOSIT
      =================================================== */

      if (
        action === 'reject' &&
        type === 'dep'
      ) {

        await telegram(
          'answerCallbackQuery',
          {
            callback_query_id: query.id,
            text: 'Deposit rejected ❌'
          }
        );

        await telegram(
          'sendMessage',
          {
            chat_id: userId,
            text:
              '❌ Your deposit could not be verified.\n\n' +
              'Please contact Ha Fantasy support.'
          }
        );

        await telegram(
          'editMessageText',
          {
            chat_id:
              query.message.chat.id,

            message_id:
              query.message.message_id,

            text:
              `${query.message.text || ''}` +
              '\n\n❌ STATUS: REJECTED'
          }
        );

        return res.status(200).json({
          ok: true
        });
      }


      /* ===================================================
         MARK WITHDRAWAL PAID
      =================================================== */

      if (
        action === 'paid' &&
        type === 'wit'
      ) {

        try {

          const newBalance =
            await approveWithdrawal(
              userId,
              amount
            );

          await telegram(
            'answerCallbackQuery',
            {
              callback_query_id: query.id,
              text: 'Withdrawal marked as paid ✅'
            }
          );

          await telegram(
            'sendMessage',
            {
              chat_id: userId,
              text:
                `🎉 Withdrawal of *${amount} ETB* has been paid!\n\n` +
                `💰 Remaining balance: *${newBalance} ETB*`,
              parse_mode: 'Markdown'
            }
          );

          await telegram(
            'editMessageText',
            {
              chat_id:
                query.message.chat.id,

              message_id:
                query.message.message_id,

              text:
                `${query.message.text || ''}` +
                `\n\n✅ STATUS: PAID OUT (−${amount} ETB)`,

              parse_mode: 'Markdown'
            }
          );

        } catch (error) {

          console.error(error);

          await telegram(
            'answerCallbackQuery',
            {
              callback_query_id: query.id,
              text:
                `Error: ${error.message}`,
              show_alert: true
            }
          );
        }

        return res.status(200).json({
          ok: true
        });
      }


      /* ===================================================
         REJECT WITHDRAWAL
      =================================================== */

      if (
        action === 'reject' &&
        type === 'wit'
      ) {

        await telegram(
          'answerCallbackQuery',
          {
            callback_query_id: query.id,
            text: 'Withdrawal rejected ❌'
          }
        );

        await telegram(
          'sendMessage',
          {
            chat_id: userId,
            text:
              '❌ Your withdrawal request was rejected.'
          }
        );

        await telegram(
          'editMessageText',
          {
            chat_id:
              query.message.chat.id,

            message_id:
              query.message.message_id,

            text:
              `${query.message.text || ''}` +
              '\n\n❌ STATUS: REJECTED'
          }
        );

        return res.status(200).json({
          ok: true
        });
      }

      return res.status(200).json({
        ok: true
      });
    }


    return res.status(200).json({
      ok: true
    });

  } catch (error) {

    console.error(
      'Ha Fantasy webhook error:',
      error
    );

    /*
     * Return 200 so Telegram doesn't repeatedly retry
     * an update that our application failed to process.
     */
    return res.status(200).json({
      ok: false
    });
  }
};
