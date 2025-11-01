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
    const role = String(payload.role || '').trim().toLowerCase();
    if(!email || !role){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'email과 role이 필요합니다.' }) };
    }
    if(email === LOCKED_EMAIL.toLowerCase()){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'이 계정은 역할을 변경할 수 없습니다.' }) };
    }
    if(!['user','super'].includes(role)){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'role은 user 또는 super 이어야 합니다.' }) };
    }

    const { data: listResult, error: listError } = await supabaseAdmin.auth.admin.listUsers({ email });
    if(listError) throw listError;
    const target = (listResult?.users || []).find(u => String(u.email || '').toLowerCase() === email);
    if(!target){
      return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'해당 사용자를 찾을 수 없습니다.' }) };
    }

    const metadata = Object.assign({}, target.user_metadata || {});
    metadata.role = role;
    if(role === 'super' && !SUPER_ADMINS.includes(email)){
      SUPER_ADMINS.push(email);
    }

    const { data: updated, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(target.id, {
      user_metadata: metadata
    });
    if(updateError) throw updateError;

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:true, role: metadata.role }) };
  } catch (err) {
    console.error('[update-user-role]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: err.message || '역할을 변경할 수 없습니다.' })
    };
  }
};
