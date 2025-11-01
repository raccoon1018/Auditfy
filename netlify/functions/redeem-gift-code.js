require('./_shared/loadEnv');
const authorize = require('./_shared/authorize');
const supabaseAdmin = require('./_shared/supabaseAdmin');

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

async function updateUserPlan(userId, planId, months){
  const result = await supabaseAdmin.auth.admin.getUserById(userId);
  if(result.error) throw result.error;
  const user = result.data;
  if(!user) throw new Error('사용자를 찾을 수 없습니다.');
  const metadata = Object.assign({}, user.user_metadata || {});
  metadata.plan = planId;
  metadata.planUpdatedAt = new Date().toISOString();
  if (months && Number.isFinite(months) && months > 0) {
    const current = metadata.planExpiresAt ? new Date(metadata.planExpiresAt) : new Date();
    const start = isNaN(current.getTime()) ? new Date() : current > new Date() ? current : new Date();
    const expires = new Date(start);
    expires.setMonth(expires.getMonth() + months);
    metadata.planExpiresAt = expires.toISOString();
  }
  const upd = await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: metadata });
  if(upd.error) throw upd.error;
  return upd.data;
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
    const user = await authorize(event);
    if(!user){
      return {
        statusCode: 401,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'로그인이 필요합니다.' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const codeRaw = String(body.code || '').trim();
    if(!codeRaw){
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'코드를 입력해주세요.' })
      };
    }

    const code = codeRaw.toUpperCase();
    const { data, error } = await supabaseAdmin
      .from('plan_gift_codes')
      .select('*')
      .eq('code', code)
      .maybeSingle();
    if(error) throw error;
    if(!data){
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'유효하지 않은 코드입니다.' })
      };
    }
    if (data.redeemed_by) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'이미 사용된 코드입니다.' })
      };
    }
    if (data.expires_at) {
      const expires = new Date(data.expires_at);
      if(!isNaN(expires.getTime()) && expires < new Date()){
        return {
          statusCode: 400,
          headers: corsHeaders(),
          body: JSON.stringify({ ok:false, error:'만료된 코드입니다.' })
        };
      }
    }

    const months = Number(data.months || 0);
    const updatedUser = await updateUserPlan(user.id, data.plan_id, months);

    const { error: updateCodeError, data: updatedCode } = await supabaseAdmin
      .from('plan_gift_codes')
      .update({
        redeemed_by: user.email,
        redeemed_at: new Date().toISOString()
      })
      .eq('code', code)
      .select('*')
      .single();
    if(updateCodeError) throw updateCodeError;

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        plan: updatedUser?.user_metadata?.plan,
        planExpiresAt: updatedUser?.user_metadata?.planExpiresAt || null,
        code: updatedCode
      })
    };
  } catch (err) {
    console.error('[redeem-gift-code]', err);
    const message = err.message || '코드를 적용할 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};
