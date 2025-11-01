require('./_shared/loadEnv');
const authorize = require('./_shared/authorize');
const supabaseAdmin = require('./_shared/supabaseAdmin');

const SUPER_ADMINS = (process.env.SUPER_ADMINS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

const LOCKED_EMAIL = 'yoon080708@gmail.com';

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

function isSuper(user){
  if(!user) return false;
  const email = String(user.email || '').toLowerCase();
  if(email && SUPER_ADMINS.includes(email)) return true;
  const role = String(user.user_metadata?.role || '').toLowerCase();
  return role === 'super';
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
      return { statusCode: 403, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'슈퍼관리자 권한이 필요합니다.' }) };
    }

    const payload = JSON.parse(event.body || '{}');
    const email = String(payload.email || '').trim().toLowerCase();
    if(!email){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'email이 필요합니다.' }) };
    }
    if(email === LOCKED_EMAIL.toLowerCase()){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'이 계정은 삭제할 수 없습니다.' }) };
    }

    const { data: listResult, error: listError } = await supabaseAdmin.auth.admin.listUsers({ email });
    if(listError) throw listError;
    const target = (listResult?.users || []).find(u => String(u.email || '').toLowerCase() === email);
    if(!target){
      return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'해당 사용자를 찾을 수 없습니다.' }) };
    }

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(target.id);
    if(deleteError) throw deleteError;

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:true }) };
  } catch (err) {
    console.error('[delete-user]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: err.message || '사용자를 삭제할 수 없습니다.' })
    };
  }
};
