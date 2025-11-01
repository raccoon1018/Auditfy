const supabaseAdmin = require('./_shared/supabaseAdmin');
const authorize = require('./_shared/authorize');

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
      body: JSON.stringify({ ok:false, error:'Supabase 연결이 필요합니다.' })
    };
  }

  try {
    const user = await authorize(event);
    const { data, error } = await supabaseAdmin
      .from('cloud_files')
      .select('id,name,size,path,updated_at')
      .eq('owner', user.id)
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message || '목록을 불러올 수 없습니다.');

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, items: data || [] })
    };
  } catch (err) {
    console.error('[list-cloud]', err);
    const message = err.message || '목록을 불러올 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};
