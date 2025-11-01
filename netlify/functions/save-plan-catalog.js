require('./_shared/loadEnv');
const authorize = require('./_shared/authorize');
const supabaseAdmin = require('./_shared/supabaseAdmin');

const SUPER_ADMINS = (process.env.SUPER_ADMINS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

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

function isRelationMissing(error){
  return error && /does not exist/i.test(error.message || '');
}

function normalizePlan(plan){
  const withDefault = Object.assign({
    currency:'KRW',
    description:'',
    perks:[]
  }, plan);
  return {
    id: String(withDefault.id || '').trim(),
    label: String(withDefault.label || '').trim(),
    description: String(withDefault.description || '').trim(),
    currency: String(withDefault.currency || 'KRW').trim(),
    project_bytes: Number(withDefault.quotas?.projectBytes ?? withDefault.projectBytes ?? 0),
    cloud_bytes: Number(withDefault.quotas?.cloudBytes ?? withDefault.cloudBytes ?? 0),
    price_monthly: Number(withDefault.pricing?.monthly ?? withDefault.priceMonthly ?? 0),
    price_usd_monthly: Number(withDefault.pricing?.usdMonthly ?? withDefault.priceUsdMonthly ?? 0),
    perks: JSON.stringify(Array.isArray(withDefault.perks) ? withDefault.perks : [])
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
      return { statusCode: 403, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'슈퍼관리자 권한이 필요합니다.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const plans = Array.isArray(body.plans) ? body.plans : [];
    if(!plans.length){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'저장할 플랜 데이터가 없습니다.' }) };
    }

    const normalized = plans.map(normalizePlan).filter(p => p.id && p.label);
    if(!normalized.length){
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'유효한 플랜 데이터가 없습니다.' }) };
    }

    const ids = normalized.map(p=>p.id);

    const { error: upsertError } = await supabaseAdmin
      .from('plan_catalog')
      .upsert(normalized, { onConflict: 'id' });

    if (upsertError) {
      if (isRelationMissing(upsertError)) {
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:false, schemaMissing:true, error:'plan_catalog 테이블이 필요합니다.' }) };
      }
      throw upsertError;
    }

    // remove plans not included if requested
    if(body.replaceAll === true){
      const { error: delError } = await supabaseAdmin
        .from('plan_catalog')
        .delete()
        .not('id', 'in', `(${ids.map(id=>`"${id}"`).join(',')})`);
      if (delError && !isRelationMissing(delError)) {
        throw delError;
      }
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:true }) };
  } catch (err) {
    console.error('[save-plan-catalog]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: err.message || '플랜 정보를 저장할 수 없습니다.' })
    };
  }
};
