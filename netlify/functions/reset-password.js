require('./_shared/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, MAIL_USER, MAIL_PASS, MAIL_FROM } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[reset-password] Supabase 환경변수가 설정되지 않았습니다.');
}

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const transporter = (MAIL_USER && MAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: MAIL_USER, pass: MAIL_PASS }
    })
  : null;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  if (!supabaseAdmin) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Supabase 설정이 필요합니다.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: '잘못된 요청 형식입니다.' }) };
  }

  const email = String(payload.email || '').trim();
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: '이메일을 입력해주세요.' }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: '올바른 이메일 형식이 아닙니다.' }) };
  }

  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserByEmail(email);
    if (error || !data?.user) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: '가입되지 않은 이메일입니다.' }) };
    }

    const user = data.user;
    const tempPassword = generateTempPassword();

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: tempPassword
    });
    if (updateError) {
      console.error('[reset-password] updateUserById error', updateError);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: '임시 비밀번호 생성에 실패했습니다.' }) };
    }

    if (!transporter) {
      console.warn('[reset-password] 메일 전송 설정이 없어 이메일을 보내지 못했습니다.');
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: '메일 전송 설정이 필요합니다. 서버 관리자에게 문의하세요.' }) };
    }

    await transporter.sendMail({
      from: MAIL_FROM || MAIL_USER,
      to: email,
      subject: '[Auditfy] 임시 비밀번호 안내',
      text: createMailBody(tempPassword),
      html: createMailBody(tempPassword).replace(/\n/g, '<br />')
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[reset-password] unexpected error', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: '임시 비밀번호 발급에 실패했습니다.' }) };
  }
};

function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

function createMailBody(tempPassword) {
  return [
    '안녕하세요, Auditfy 임시 비밀번호 안내입니다.',
    '',
    `임시 비밀번호: ${tempPassword}`,
    '',
    '로그인 후 반드시 비밀번호를 변경해주세요.',
    '감사합니다.'
  ].join('\n');
}
