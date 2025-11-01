require('./_shared/loadEnv');
const authorize = require('./_shared/authorize');
const supabaseAdmin = require('./_shared/supabaseAdmin');

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

function isRelationMissing(error){
  return error && /does not exist/i.test(error.message || '');
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
    const query = supabaseAdmin
      .from('announcements')
      .select('id,title,body,is_banner,is_active,created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) {
      if (isRelationMissing(error)) {
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok:true, announcements: [], schemaMissing:true }) };
      }
      throw error;
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, announcements: data || [] })
    };
  } catch (err) {
    console.error('[list-announcements]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: err.message || '공지사항을 불러올 수 없습니다.' })
    };
  }
};
