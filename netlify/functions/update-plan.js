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
    const email = String(body.email || '').trim().toLowerCase();
    const plan = String(body.plan || '').trim();
    const expiresAtRaw = body.expiresAt ? String(body.expiresAt).trim() : null;

    if (!email || !plan) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'email과 plan은 필수입니다.' })
      };
    }

    const { data: listResult, error: listError } = await supabaseAdmin.auth.admin.listUsers({ email });
    if (listError) throw listError;
    const target = (listResult?.users || []).find(u => String(u.email || '').toLowerCase() === email);
    if (!target) {
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'해당 이메일의 사용자를 찾을 수 없습니다.' })
      };
    }

    const userId = target.id;
    const metadata = Object.assign({}, target.user_metadata || {});
    metadata.plan = plan;
    metadata.planUpdatedAt = new Date().toISOString();
    if (expiresAtRaw) {
      const expiresAt = new Date(expiresAtRaw).toISOString();
      metadata.planExpiresAt = expiresAt;
    } else {
      delete metadata.planExpiresAt;
    }

    const { data: updated, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: metadata
    });
    if (updateError) throw updateError;

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        user: {
          id: updated?.id,
          email: updated?.email,
          plan: updated?.user_metadata?.plan,
          planExpiresAt: updated?.user_metadata?.planExpiresAt || null
        }
      })
    };
  } catch (err) {
    console.error('[update-plan]', err);
    const message = err.message || '플랜을 변경할 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};
