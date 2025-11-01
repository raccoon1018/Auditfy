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
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: 'OK' };
  }

  if (event.httpMethod !== 'GET') {
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

    const { data, error } = await supabaseAdmin
      .from('plan_gift_codes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, codes: data || [] })
    };
  } catch (err) {
    console.error('[list-gift-codes]', err);
    const message = err.message || '기프트 코드를 불러올 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};
