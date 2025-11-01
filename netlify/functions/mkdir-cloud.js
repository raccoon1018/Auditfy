require('./_shared/loadEnv');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
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
    const rawName = String(body.name || '').trim();
    const parent = String(body.parent || '').trim();

    if (!rawName) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'폴더 이름이 필요합니다.' })
      };
    }

    const name = sanitize(rawName);
    if (!name) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'유효한 폴더 이름이 아닙니다.' })
      };
    }

    const folderPath = buildFolderPath(parent, name);
    const keyPrefix = `${user.id}/${folderPath}`;
    const markerKey = `${keyPrefix}/__folder__`;

    const { data: existing, error: existingError } = await supabaseAdmin
      .from('cloud_files')
      .select('id')
      .eq('owner', user.id)
      .eq('path', markerKey)
      .maybeSingle();

    if (existingError) {
      throw new Error(existingError.message || '폴더 존재 여부를 확인할 수 없습니다.');
    }

    if (existing) {
      return {
        statusCode: 409,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'동일한 이름의 폴더가 이미 있습니다.' })
      };
    }

    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_CLOUD,
      Key: markerKey,
      Body: '',
      ContentType: 'application/x-empty'
    }));

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('cloud_files')
      .insert({
        owner: user.id,
        name,
        size: 0,
        path: markerKey,
        updated_at: new Date().toISOString()
      })
      .select('id,name,path,updated_at')
      .single();

    if (insertError) {
      throw new Error(insertError.message || '폴더 정보를 저장하지 못했습니다.');
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, folder:{ id: inserted?.id, name, path: folderPath } })
    };
  } catch (err) {
    console.error('[mkdir-cloud]', err);
    const message = err.message || '폴더를 생성할 수 없습니다.';
    const status = message.includes('인증') ? 401 : (message.includes('이미 있습니다') ? 409 : 500);
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};

function sanitize(name){
  return String(name || '')
    .replace(/[\\r\\n]/g,'')
    .replace(/[<>"'`\\]/g,'')
    .trim();
}

function buildFolderPath(parent, name){
  const segments = [];
  const cleanedParent = String(parent || '').split('/')
    .map(seg => sanitize(seg))
    .filter(Boolean);
  if (cleanedParent.length) segments.push(...cleanedParent);
  segments.push(name);
  return segments.join('/');
}
