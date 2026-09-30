const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '-1004468798532').trim();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const TG_BASE = 'https://api.telegram.org/bot' + BOT_TOKEN;

function db() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

/* =========================================================
   TELEGRAM API
========================================================= */

async function tg(method, body = {}) {
  const url = TG_BASE + '/' + method;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!data.ok) {
    console.error('Telegram API error (' + method + '):', data);
  }

  return data;
}

/* =========================================================
   TELEGRAM WEBAPP AUTHENTICATION
========================================================= */

function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');

    if (!receivedHash) return null;

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(function(a, b) { return a[0].localeCompare(b[0]); })
      .map(function(entry) { return entry[0] + '=' + entry[1]; })
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (
      calculatedHash.length !== receivedHash.length ||
      !crypto.timingSafeEqual(
        Buffer.from(calculatedHash),
        Buffer.from(receivedHash)
      )
    ) {
      return null;
    }

    const userRaw = params.get('user');
    if (!userRaw) return null;

    return JSON.parse(userRaw);
  } catch (error) {
    console.error('Telegram auth error:', error);
    return null;
  }
}

/* =========================================================
   USER LABEL
========================================================= */

function userLabel(user) {
  if (!user) return 'Unknown';

  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ');

  const username = user.username ? '@' + user.username : 'No username';

  return (name || 'Unknown') + ' (' + username + ')';
}

/* =========================================================
   GET / CREATE WALLET
========================================================= */

async function getWallet(telegramId, userName) {
  const sb = db();
  const tid = String(telegramId);

  let { data: wallet, error } = await sb
    .from('user_wallets')
    .select('*')
    .eq('telegram_id', tid)
    .maybeSingle();

  if (error) throw error;
  if (wallet) return wallet;

  const newWallet = {
    telegram_id: tid,
    user_name: userName || 'Manager',
    balance: 0,
    total_deposits: 0,
    total_withdrawals: 0,
    total_winnings: 0
  };

  const result = await sb
    .from('user_wallets')
    .upsert(newWallet, { onConflict: 'telegram_id' })
    .select()
    .single();

  if (result.error) throw result.error;
  return result.data;
}

/* =========================================================
   CHECK ADMIN
========================================================= */

async function isAdmin(userId) {
  try {
    const result = await tg('getChatMember', {
      chat_id: ADMIN_CHAT_ID,
      user_id: userId
    });

    if (!result.ok) return false;

    const status = result.result.status;
    return status === 'creator' || status === 'administrator';
  } catch (error) {
    console.error('Admin check failed:', error);
    return false;
  }
}

/* =========================================================
   CREATE WALLET REQUEST
========================================================= */

async function createWalletRequest(data) {
  const sb = db();
  const amount = Number(data.amount);
  const reqType = String(data.type || '').toLowerCase(); // deposit | withdrawal

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid amount');
  }

  if (reqType !== 'deposit' && reqType !== 'withdrawal') {
    throw new Error('Invalid wallet request type');
  }

  let details = data.receipt || null;
  if (reqType === 'withdrawal') {
    const bits = [
      'Method: ' + (data.method || 'telebirr'),
      data.accountName ? ('Account name: ' + data.accountName) : null,
      data.accountNo ? ('Account / phone: ' + data.accountNo) : null
    ].filter(Boolean);
    details = bits.join('\n');
  }

  // IMPORTANT: your table has NOT NULL column named "type"
  // Also may have "request_type" — set BOTH so either schema works.
  const row = {
    telegram_id: String(data.telegramId),
    user_name: data.userName || 'Manager',
    amount: amount,
    method: data.method || 'telebirr',
    receipt: details,
    status: 'pending'
  };
  row['type'] = reqType;
  row['request_type'] = reqType;
  row['account_name'] = data.accountName || null;
  row['account_no'] = data.accountNo || null;

  console.log('Inserting wallet_requests row:', JSON.stringify(row));

  let result = await sb.from('wallet_requests').insert(row).select().single();

  // Drop optional columns that may not exist and retry
  if (result.error) {
    const msg = String(result.error.message || result.error.code || '');
    console.warn('wallet_requests insert error, retrying stripped:', msg);

    const attempts = [
      // without account fields
      function(r) { const x = Object.assign({}, r); delete x.account_name; delete x.account_no; return x; },
      // without request_type
      function(r) { const x = Object.assign({}, r); delete x.account_name; delete x.account_no; delete x.request_type; return x; },
      // without type (only if request_type works — last resort; prefer keeping type)
      function(r) { const x = Object.assign({}, r); delete x.account_name; delete x.account_no; delete x.user_name; return x; }
    ];

    for (let i = 0; i < attempts.length; i++) {
      const payload = attempts[i](row);
      // NEVER delete type — it is NOT NULL on this database
      payload['type'] = reqType;
      console.log('Retry payload', i, JSON.stringify(payload));
      result = await sb.from('wallet_requests').insert(payload).select().single();
      if (!result.error) break;
      console.warn('Retry', i, 'failed:', result.error.message);
    }
  }

  if (result.error) throw result.error;

  const created = result.data || {};
  created.account_name = created.account_name || data.accountName || null;
  created.account_no = created.account_no || data.accountNo || null;
  created.method = created.method || data.method || 'telebirr';
  created.type = created.type || reqType;
  created.request_type = created.request_type || reqType;
  return created;
}

/* =========================================================
   SEND DEPOSIT REQUEST TO ADMIN GROUP
========================================================= */

async function sendDepositRequest(request) {
  const text = '🚨 NEW DEPOSIT REQUEST\n\n' +
    '👤 User: ' + request.user_name + '\n' +
    '🆔 Telegram ID: ' + request.telegram_id + '\n\n' +
    '💵 Amount: ' + request.amount + ' ETB\n\n' +
    '📜 Telebirr Receipt:\n' +
    String(request.receipt || 'No receipt provided').slice(0, 1500) + '\n\n' +
    '🆔 Request ID:\n' + request.id + '\n\n' +
    '⏳ STATUS: PENDING';

  return tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text: text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '✅ APPROVE DEPOSIT',
            callback_data: 'approve_dep_' + request.id
          }
        ],
        [
          {
            text: '❌ REJECT DEPOSIT',
            callback_data: 'reject_dep_' + request.id
          }
        ]
      ]
    }
  });
}

/* =========================================================
   SEND WITHDRAWAL REQUEST TO ADMIN GROUP
========================================================= */

async function sendWithdrawalRequest(request) {
  const text = '💸 NEW WITHDRAWAL REQUEST\n\n' +
    '👤 User: ' + request.user_name + '\n' +
    '🆔 Telegram ID: ' + request.telegram_id + '\n\n' +
    '💵 Amount: ' + request.amount + ' ETB\n\n' +
    '🏦 Method: ' + String(request.method || 'telebirr').toUpperCase() + '\n\n' +
    '👤 Account Name:\n' + (request.account_name || '—') + '\n\n' +
    '📱 Account / Phone:\n' + (request.account_no || '—') + '\n\n' +
    '🆔 Request ID:\n' + request.id + '\n\n' +
    '⏳ STATUS: PENDING';

  return tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text: text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '✅ MARK PAID',
            callback_data: 'paid_wit_' + request.id
          }
        ],
        [
          {
            text: '❌ REJECT WITHDRAWAL',
            callback_data: 'reject_wit_' + request.id
          }
        ]
      ]
    }
  });
}

/* =========================================================
   PROCESS REQUEST
========================================================= */

async function processRequest(requestId) {
  const { data, error } = await db().rpc('process_wallet_request', {
    p_request_id: requestId
  });

  if (error) throw error;
  return data;
}

/* =========================================================
   REJECT REQUEST
========================================================= */

async function rejectRequest(requestId) {
  const sb = db();

  const { data: request, error } = await sb
    .from('wallet_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error) throw error;

  if (request.status !== 'pending') {
    throw new Error('Request already processed: ' + request.status);
  }

  const { error: updateError } = await sb
    .from('wallet_requests')
    .update({
      status: 'rejected',
      processed_at: new Date().toISOString()
    })
    .eq('id', requestId)
    .eq('status', 'pending');

  if (updateError) throw updateError;
  return request;
}

/* =========================================================
   EDIT ADMIN MESSAGE
========================================================= */

async function updateAdminMessage(query, statusText) {
  if (!query.message) return;

  const oldText = query.message.text || '';

  await tg('editMessageText', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: oldText + '\n\n' + statusText,
    reply_markup: {
      inline_keyboard: []
    }
  });
}

/* =========================================================
   HANDLE ADMIN CALLBACK
========================================================= */

async function handleCallback(query) {
  if (!query.message || String(query.message.chat.id) !== ADMIN_CHAT_ID) {
    await tg('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Unauthorized',
      show_alert: true
    });
    return;
  }

  const admin = await isAdmin(query.from.id);

  if (!admin) {
    await tg('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Only group admins can process wallet requests.',
      show_alert: true
    });
    return;
  }

  const parts = String(query.data || '').split('_');
  const action = parts[0];
  const type = parts[1];
  const requestId = parts.slice(2).join('_');

  if (!requestId) {
    await tg('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Invalid request.',
      show_alert: true
    });
    return;
  }

  // DEPOSIT APPROVAL
  if (action === 'approve' && type === 'dep') {
    try {
      const result = await processRequest(requestId);

      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Deposit approved ✅'
      });

      await tg('sendMessage', {
        chat_id: result.telegram_id,
        text: '🎉 DEPOSIT APPROVED\n\n💵 Amount: ' + result.amount + ' ETB\n\n💰 New wallet balance:\n' + result.new_balance + ' ETB'
      });

      await updateAdminMessage(query, '✅ STATUS: APPROVED (+' + result.amount + ' ETB)');
    } catch (error) {
      console.error('Deposit approval error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not approve.',
        show_alert: true
      });
    }
    return;
  }

  // DEPOSIT REJECTION
  if (action === 'reject' && type === 'dep') {
    try {
      const request = await rejectRequest(requestId);

      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Deposit rejected ❌'
      });

      await tg('sendMessage', {
        chat_id: request.telegram_id,
        text: '❌ DEPOSIT REJECTED\n\nYour ' + request.amount + ' ETB deposit could not be verified.\n\nPlease contact Ha Fantasy support if you believe this was a mistake.'
      });

      await updateAdminMessage(query, '❌ STATUS: REJECTED');
    } catch (error) {
      console.error('Deposit rejection error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not reject.',
        show_alert: true
      });
    }
    return;
  }

  // WITHDRAWAL PAID
  if (action === 'paid' && type === 'wit') {
    try {
      const result = await processRequest(requestId);

      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Withdrawal marked as paid ✅'
      });

      await tg('sendMessage', {
        chat_id: result.telegram_id,
        text: '💸 WITHDRAWAL COMPLETED\n\n💵 Amount: ' + result.amount + ' ETB\n\n💰 Remaining balance:\n' + result.new_balance + ' ETB'
      });

      await updateAdminMessage(query, '✅ STATUS: PAID OUT (-' + result.amount + ' ETB)');
    } catch (error) {
      console.error('Withdrawal payment error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not process withdrawal.',
        show_alert: true
      });
    }
    return;
  }

  // WITHDRAWAL REJECT
  if (action === 'reject' && type === 'wit') {
    try {
      const request = await rejectRequest(requestId);

      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Withdrawal rejected ❌'
      });

      await tg('sendMessage', {
        chat_id: request.telegram_id,
        text: '❌ WITHDRAWAL REJECTED\n\nYour ' + request.amount + ' ETB withdrawal request was rejected.\n\nYour wallet balance was not changed.'
      });

      await updateAdminMessage(query, '❌ STATUS: REJECTED — BALANCE UNCHANGED');
    } catch (error) {
      console.error('Withdrawal rejection error:', error);
      await tg('answerCallbackQuery', {
        callback_query_id: query.id,
        text: error.message || 'Could not reject.',
        show_alert: true
      });
    }
    return;
  }

  await tg('answerCallbackQuery', {
    callback_query_id: query.id,
    text: 'Unknown action.'
  });
}

/* =========================================================
   MAIN HANDLER
========================================================= */

module.exports = async function handler(req, res) {
  // CORS — required so ha-fantasy.onrender.com can call this API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // HEALTH CHECK / GET WALLET
  if (req.method === 'GET') {
    const action = req.query && req.query.action;

    if (action === 'wallet') {
      try {
        const initData = req.headers.authorization || '';
        const user = verifyTelegramInitData(initData);

        if (!user) {
          return res.status(401).json({
            ok: false,
            error: 'Invalid Telegram authentication'
          });
        }

        const wallet = await getWallet(
          user.id,
          [user.first_name, user.last_name].filter(Boolean).join(' ')
        );

        return res.status(200).json({
          ok: true,
          wallet: {
            balance: Number(wallet.balance || 0),
            total_deposits: Number(wallet.total_deposits || 0),
            total_withdrawals: Number(wallet.total_withdrawals || 0),
            total_winnings: Number(wallet.total_winnings || 0)
          }
        });
      } catch (error) {
        console.error('GET wallet error:', error);
        return res.status(500).json({
          ok: false,
          error: error.message
        });
      }
    }

    return res.status(200).send('Ha Fantasy wallet API OK');
  }

  // ONLY POST AFTER THIS POINT
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const update = req.body || {};

    // TELEGRAM CALLBACK QUERY
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return res.status(200).json({ ok: true });
    }

    // TELEGRAM WEBAPP DATA
    if (update.message && update.message.web_app_data) {
      const message = update.message;
      const user = message.from;

      let data;
      try {
        data = JSON.parse(message.web_app_data.data);
      } catch (e) {
        return res.status(200).json({ ok: true });
      }

      if (data.type === 'DEPOSIT_SUBMISSION') {
        const request = await createWalletRequest({
          telegramId: user.id,
          userName: userLabel(user),
          type: 'deposit',
          amount: data.amount,
          receipt: data.receipt || ''
        });
        await sendDepositRequest(request);
      }

      if (data.type === 'WITHDRAWAL_REQUEST') {
        const request = await createWalletRequest({
          telegramId: user.id,
          userName: userLabel(user),
          type: 'withdrawal',
          amount: data.amount,
          method: data.method,
          accountName: data.accountName,
          accountNo: data.accountNo
        });
        await sendWithdrawalRequest(request);
      }

      return res.status(200).json({ ok: true });
    }

    // DIRECT HTML WALLET REQUEST
    if (update.action === 'wallet_request') {
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: 'Invalid Telegram authentication'
        });
      }

      const type = update.type;

      if (type !== 'deposit' && type !== 'withdrawal') {
        return res.status(400).json({
          ok: false,
          error: 'Invalid wallet request type'
        });
      }

      const amount = Number(update.amount);

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid amount'
        });
      }

      if (type === 'withdrawal') {
        const wallet = await getWallet(
          user.id,
          [user.first_name, user.last_name].filter(Boolean).join(' ')
        );

        if (Number(wallet.balance || 0) < amount) {
          return res.status(400).json({
            ok: false,
            error: 'Insufficient balance'
          });
        }
      }

      const request = await createWalletRequest({
        telegramId: user.id,
        userName: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager',
        type: type,
        amount: amount,
        method: update.method || 'telebirr',
        accountName: update.accountName,
        accountNo: update.accountNo,
        receipt: update.receipt
      });

      if (type === 'deposit') {
        const result = await sendDepositRequest(request);
        if (!result.ok) {
          throw new Error('Could not send deposit request to admin group');
        }
      } else {
        const result = await sendWithdrawalRequest(request);
        if (!result.ok) {
          throw new Error('Could not send withdrawal request to admin group');
        }
      }

      return res.status(200).json({
        ok: true,
        request_id: request.id,
        message: type === 'deposit'
          ? 'Deposit request sent for approval.'
          : 'Withdrawal request sent for processing.'
      });
    }

    // UNKNOWN POST
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('Ha Fantasy API error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Server error'
    });
  }
};
