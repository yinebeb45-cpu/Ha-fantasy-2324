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



/* =========================================================
   TELEBIRR TXN ID + DUPLICATE RECEIPT BLOCK
========================================================= */

function extractTxnId(receipt) {
  if (!receipt) return null;
  const text = String(receipt);

  let m = text.match(/transaction number is\s*[:\s]*([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();

  m = text.match(/txn(?:\s*id|\s*no|#)?\s*[:\s]*([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();

  m = text.match(/receipt\/([A-Za-z0-9]+)/i);
  if (m) return m[1].toUpperCase();

  // Codes like DIM90ZLL6L
  m = text.match(/\b([A-Z]{2,}\d{2,}[A-Z0-9]{2,})\b/i);
  if (m) return m[1].toUpperCase();

  return null;
}

async function assertNoDuplicateReceipt(receipt, telegramId) {
  const txn = extractTxnId(receipt);
  const sb = db();

  if (!txn) {
    console.warn('No txn id parsed from receipt for', telegramId);
    // Still block exact same full receipt text
    const trimmed = String(receipt || '').trim();
    if (trimmed.length > 40) {
      const { data: same } = await sb
        .from('wallet_requests')
        .select('id, telegram_id, status')
        .ilike('receipt', trimmed.slice(0, 80) + '%')
        .limit(5);
      if (same && same.length) {
        throw new Error('This receipt text was already submitted (request #' + same[0].id + ').');
      }
    }
    return { txn: null };
  }

  // Search receipts containing this txn (any status)
  const { data: rows, error } = await sb
    .from('wallet_requests')
    .select('id, telegram_id, status, receipt, type, request_type')
    .ilike('receipt', '%' + txn + '%')
    .limit(20);

  if (error) {
    console.warn('duplicate check error:', error.message);
    // fallback: load recent and scan in JS
    const { data: recent } = await sb
      .from('wallet_requests')
      .select('id, telegram_id, status, receipt, type, request_type')
      .order('id', { ascending: false })
      .limit(100);
    const hit = (recent || []).find(function(r) {
      const rec = String(r.receipt || '').toUpperCase();
      return rec.indexOf(txn) !== -1;
    });
    if (hit) {
      throw new Error('Duplicate Telebirr receipt (txn ' + txn + '). Already used on request #' + hit.id + '.');
    }
    return { txn: txn };
  }

  if (rows && rows.length > 0) {
    throw new Error('Duplicate Telebirr receipt (txn ' + txn + '). Already used on request #' + rows[0].id + '.');
  }

  return { txn: txn };
}

/* =========================================================
   SERVER-SIDE JOIN LEAGUE (deduct 100 ETB)
========================================================= */

async function joinLeagueServer(user, league, gameweek) {
  const sb = db();
  const lg = String(league || '').toUpperCase();
  if (lg !== 'EPL' && lg !== 'UCL') throw new Error('Invalid league');
  const gw = Number(gameweek) || 1;
  const tid = String(user.id);
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Manager';
  const ENTRY = 100;

  console.log('joinLeagueServer', tid, lg, gw);

  // Already paid?
  const { data: existingRows, error: exErr } = await sb
    .from('user_squads')
    .select('*')
    .eq('telegram_id', tid)
    .eq('league', lg)
    .eq('gameweek', gw);

  if (exErr) console.warn('existing squad lookup', exErr.message);

  const existing = (existingRows && existingRows[0]) || null;
  if (existing && (existing.paid === true || existing.paid === 'true' || existing.paid === 1)) {
    const wallet = await getWallet(tid, userName);
    return { already: true, league: lg, balance: Number(wallet.balance || 0) };
  }

  const wallet = await getWallet(tid, userName);
  const balance = Number(wallet.balance || 0);
  if (balance < ENTRY) {
    throw new Error('Insufficient balance. Need 100 ETB (you have ' + balance + ').');
  }

  const newBalance = balance - ENTRY;
  const { error: wErr } = await sb
    .from('user_wallets')
    .update({ balance: newBalance })
    .eq('telegram_id', tid);
  if (wErr) throw wErr;

  // Upsert paid flag — try update first, then insert
  let squadOk = false;
  if (existing) {
    const { error: uErr } = await sb
      .from('user_squads')
      .update({ paid: true, user_name: userName })
      .eq('telegram_id', tid)
      .eq('league', lg)
      .eq('gameweek', gw);
    if (!uErr) squadOk = true;
    else console.warn('squad update failed', uErr.message);
  }

  if (!squadOk) {
    const { error: iErr } = await sb
      .from('user_squads')
      .insert({
        telegram_id: tid,
        user_name: userName,
        league: lg,
        gameweek: gw,
        paid: true,
        total_points: 0
      });
    if (iErr) {
      // try upsert
      const { error: upErr } = await sb
        .from('user_squads')
        .upsert({
          telegram_id: tid,
          user_name: userName,
          league: lg,
          gameweek: gw,
          paid: true,
          total_points: 0
        }, { onConflict: 'telegram_id,league,gameweek' });
      if (upErr) {
        // refund
        await sb.from('user_wallets').update({ balance: balance }).eq('telegram_id', tid);
        throw new Error('Could not mark paid: ' + upErr.message);
      }
    }
  }

  return { already: false, league: lg, balance: newBalance, charged: ENTRY };
}

/* =========================================================
   PROCESS / REJECT REQUEST (integer ids — never uuid RPC)
========================================================= */

async function processRequest(requestId) {
  const sb = db();
  const idRaw = String(requestId).trim();
  console.log('processRequest v5 id=', idRaw);

  // NEVER filter uuid-typed columns with bare integers.
  // Load pending (and fallback recent) rows, match by string id.
  let request = null;

  const { data: pending, error: pErr } = await sb
    .from('wallet_requests')
    .select('*')
    .eq('status', 'pending')
    .limit(100);

  if (pErr) console.warn('pending load', pErr.message);

  request = (pending || []).find(function(r) { return String(r.id) === idRaw; });

  if (!request) {
    const { data: recent, error: rErr } = await sb
      .from('wallet_requests')
      .select('*')
      .order('id', { ascending: false })
      .limit(50);
    if (rErr) throw new Error(rErr.message);
    request = (recent || []).find(function(r) { return String(r.id) === idRaw; });
  }

  if (!request) throw new Error('Request not found: ' + idRaw);

  const status = String(request.status || '').toLowerCase();
  if (status !== 'pending') {
    throw new Error('Request already processed: ' + request.status);
  }

  const amount = Number(request.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amount');

  const telegramId = String(request.telegram_id);
  const reqType = String(request.type || request.request_type || '').toLowerCase();

  const wallet = await getWallet(telegramId, request.user_name || 'Manager');
  const balance = Number(wallet.balance || 0);

  let newBalance = balance;
  let totalDeposits = Number(wallet.total_deposits || 0);
  let totalWithdrawals = Number(wallet.total_withdrawals || 0);

  if (reqType === 'deposit') {
    newBalance = balance + amount;
    totalDeposits += amount;
  } else if (reqType === 'withdrawal') {
    if (balance < amount) throw new Error('Insufficient balance for withdrawal');
    newBalance = balance - amount;
    totalWithdrawals += amount;
  } else {
    throw new Error('Unknown request type: ' + reqType);
  }

  const { error: walletErr } = await sb
    .from('user_wallets')
    .update({
      balance: newBalance,
      total_deposits: totalDeposits,
      total_withdrawals: totalWithdrawals
    })
    .eq('telegram_id', telegramId);

  if (walletErr) throw walletErr;

  const newStatus = reqType === 'withdrawal' ? 'paid' : 'approved';

  // Update by matching the exact id value from the row we loaded
  const { error: reqErr } = await sb
    .from('wallet_requests')
    .update({
      status: newStatus,
      processed_at: new Date().toISOString()
    })
    .eq('id', request.id)
    .eq('status', 'pending');

  if (reqErr) {
    console.warn('status update by id failed, trying filter only status+telegram', reqErr.message);
    // Last resort: update via telegram_id + amount + pending
    await sb
      .from('wallet_requests')
      .update({ status: newStatus, processed_at: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('status', 'pending')
      .eq('amount', amount);
  }

  return {
    telegram_id: telegramId,
    amount: amount,
    new_balance: newBalance,
    type: reqType,
    status: newStatus
  };
}

async function rejectRequest(requestId) {
  const sb = db();
  const idRaw = String(requestId).trim();

  const { data: pending } = await sb
    .from('wallet_requests')
    .select('*')
    .eq('status', 'pending')
    .limit(100);

  let request = (pending || []).find(function(r) { return String(r.id) === idRaw; });
  if (!request) {
    const { data: recent } = await sb
      .from('wallet_requests')
      .select('*')
      .order('id', { ascending: false })
      .limit(50);
    request = (recent || []).find(function(r) { return String(r.id) === idRaw; });
  }
  if (!request) throw new Error('Request not found: ' + idRaw);
  if (String(request.status || '').toLowerCase() !== 'pending') {
    throw new Error('Request already processed: ' + request.status);
  }

  const { error: updateError } = await sb
    .from('wallet_requests')
    .update({
      status: 'rejected',
      processed_at: new Date().toISOString()
    })
    .eq('id', request.id)
    .eq('status', 'pending');

  if (updateError) throw updateError;
  return request;
}

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

  console.log('Ha Fantasy API version: 2026-09-30-v5-join-dup');

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
        await assertNoDuplicateReceipt(data.receipt || '', user.id);
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

      if (type === 'deposit') {
        await assertNoDuplicateReceipt(update.receipt || '', user.id);
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

    // SERVER-SIDE JOIN LEAGUE (Pay 100 ETB)
    if (update.action === 'join_league') {
      const initData = update.initData || '';
      const user = verifyTelegramInitData(initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid Telegram authentication' });
      }
      try {
        const result = await joinLeagueServer(
          user,
          update.league,
          update.gameweek || 1
        );
        return res.status(200).json({
          ok: true,
          already: !!result.already,
          league: result.league,
          balance: result.balance,
          charged: result.charged || 0,
          message: result.already
            ? 'Already joined this league this week.'
            : ('Joined ' + result.league + '. 100 ETB deducted.')
        });
      } catch (e) {
        console.error('join_league error:', e);
        return res.status(400).json({ ok: false, error: e.message || 'Join failed' });
      }
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
