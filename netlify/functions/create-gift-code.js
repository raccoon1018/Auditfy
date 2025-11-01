require('./_shared/loadEnv');
const authorize = require('./_shared/authorize');
const supabaseAdmin = require('./_shared/supabaseAdmin');

const SUPER_ADMINS = (process.env.SUPER_ADMINS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

function isSuper(user){
  if(!user) return false;
  const email = String(user.email || '').toLowerCase();
  if(email && SUPER_ADMINS.includes(email)) return true;
  const role = String(user.user_metadata?.role || '').toLowerCase();
  return role === 'super';
}

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

function generateCode(planId){
  const prefix = String(planId || 'AUD').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4) || 'AUD';
  const random = Math.random().toString(36).slice(2,8).toUpperCase();
  return `${prefix}-${random}`;
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
      body: JSON.stringify({ ok:false, error:'Supabase Admin 설정이 필요합니다.' })
    };
  }

  try {
    const operator = await authorize(event);
    if (!isSuper(operator)) {
      return {
        statusCode: 403,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'슈퍼관리자 권한이 필요합니다.' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const planId = String(body.planId || '').trim();
    const months = Number(body.months || 1);
    const expiresAtRaw = body.expiresAt ? String(body.expiresAt).trim() : null;
    const note = body.note ? String(body.note).trim() : null;

    if (!planId) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'planId는 필수입니다.' })
      };
    }
    if (!Number.isFinite(months) || months <= 0) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'months 값이 올바르지 않습니다.' })
      };
    }

    const code = generateCode(planId);
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;

    const payload = {
      code,
      plan_id: planId,
      months,
      expires_at: expiresAt,
      created_by: operator.email,
      note
    };

    const { data, error } = await supabaseAdmin
      .from('plan_gift_codes')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, code: data })
    };
  } catch (err) {
    console.error('[create-gift-code]', err);
    const message = err.message || '기프트 코드를 생성할 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};
