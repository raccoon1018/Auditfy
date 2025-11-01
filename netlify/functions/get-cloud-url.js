const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const r2Client = require('./_shared/r2Client');
const supabaseAdmin = require('./_shared/supabaseAdmin');
const authorize = require('./_shared/authorize');

const { R2_BUCKET_CLOUD } = process.env;

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

  if (!r2Client || !supabaseAdmin || !R2_BUCKET_CLOUD) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'R2 또는 Supabase 설정이 필요합니다.' })
    };
  }

  try {
    const user = await authorize(event);
    const body = JSON.parse(event.body || '{}');
    const { path } = body;

    if (!path) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'경로가 필요합니다.' })
      };
    }

    const { data, error } = await supabaseAdmin
      .from('cloud_files')
      .select('id')
      .eq('owner', user.id)
      .eq('path', path)
      .maybeSingle();

    if (error || !data) {
      throw new Error('파일을 찾을 수 없습니다.');
    }

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_CLOUD,
      Key: path
    });
    const url = await getSignedUrl(r2Client, command, { expiresIn: 300 });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, url })
    };
  } catch (err) {
    console.error('[get-cloud-url]', err);
    const message = err.message || '파일 URL을 생성할 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};
