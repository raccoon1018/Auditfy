require('./_shared/loadEnv');
const supabaseAdmin = require('./_shared/supabaseAdmin');

const { SUPER_ADMINS } = process.env;
const superAdminList = (SUPER_ADMINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const SUPER_SET = new Set(superAdminList);

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

function normalizeEmail(email){
  return String(email || '').trim().toLowerCase();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: 'OK' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'Method Not Allowed' })
    };
  }

  if (!supabaseAdmin) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'Supabase 서비스 연결이 필요합니다.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'잘못된 요청 형식입니다.' })
    };
  }

  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');
  const name = String(payload.name || '').trim();
  const kind = String(payload.kind || '').trim();
  const birthday = String(payload.birthday || '').trim();

  if (!email || !email.includes('@')) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'유효한 이메일을 입력해주세요.' })
    };
  }
  if (password.length < 8) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'비밀번호는 8자 이상이어야 합니다.' })
    };
  }

  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return {
        statusCode: 409,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'이미 가입된 이메일입니다.' })
      };
    }

    const metadata = {
      suggestedName: name || email.split('@')[0],
      plan: 'Free',
      kind: kind || 'personal',
      birthday,
      role: SUPER_SET.has(email) ? 'super' : 'user'
    };

    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // 이메일 인증을 자동으로 완료 처리
      user_metadata: metadata
    });

    if (createError) {
      throw new Error(createError.message || 'Supabase 사용자 생성에 실패했습니다.');
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, user: newUser })
    };
  } catch (err) {
    console.error('[register-user] unexpected', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'회원가입 중 오류가 발생했습니다.' })
    };
  }
};

async function findUserByEmail(email){
  if (!supabaseAdmin) return null;
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;

  const PER_PAGE = 100;
  let page = 1;

  while(true){
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(error.message || '기존 사용자 조회에 실패했습니다.');
    const users = data?.users || [];
    const hit = users.find(u => String(u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < PER_PAGE) break;
    page += 1;
  }

  return null;
}
