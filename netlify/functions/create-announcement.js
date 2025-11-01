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
    const title = String(payload.title || '').trim();
    const body = String(payload.body || '').trim();
    const isActive = payload.isActive === false ? false : true;
    const isBanner = payload.isBanner === true;

    if (!title || !body) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'제목과 본문은 필수입니다.' }) };
    }

    const insertPayload = {
      title,
      body,
      is_active: isActive,
      is_banner: isBanner,
      created_by: operator.email || null
    };

    const { data, error } = await supabaseAdmin
      .from('announcements')
      .insert(insertPayload)
      .select('id,title,body,is_banner,is_active,created_at')
      .single();

    if (error) {
      if (isRelationMissing(error)) {
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:false, schemaMissing:true, error:'announcements 테이블이 필요합니다.' }) };
      }
      throw error;
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:true, announcement:data }) };
  } catch (err) {
    console.error('[create-announcement]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: err.message || '공지사항을 생성할 수 없습니다.' })
    };
  }
};
