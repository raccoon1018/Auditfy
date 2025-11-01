require('./_shared/loadEnv');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const r2Client = require('./_shared/r2Client');
const supabaseAdmin = require('./_shared/supabaseAdmin');
const authorize = require('./_shared/authorize');

const { R2_BUCKET_CLOUD } = process.env;

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
    const { fileName, fileBase64, mimeType, folder } = body;

    if (!fileName || !fileBase64) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'파일 정보가 부족합니다.' })
      };
    }

    const buffer = Buffer.from(fileBase64, 'base64');
    const dir = normalizeFolder(folder);

    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('cloud_files')
      .select('name,path')
      .eq('owner', user.id);
    if (existingError) {
      throw new Error(existingError.message || '기존 파일 목록을 불러올 수 없습니다.');
    }

    const existingNames = new Set();
    (existingRows || []).forEach(row => {
      const folderPath = extractFolderPath(row.path, user.id);
      if (folderPath === dir) {
        const nm = String(row.name || '').trim().toLowerCase();
        if (nm) existingNames.add(nm);
      }
    });

    const finalName = uniqueName(fileName, existingNames);
    const keyParts = [user.id];
    if (dir) keyParts.push(dir);
    keyParts.push(`${Date.now()}_${sanitizeForKey(finalName)}`);
    const key = keyParts.join('/');

    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_CLOUD,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream'
    }));

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('cloud_files')
      .insert({
        owner: user.id,
        name: finalName,
        size: buffer.length,
        path: key,
        updated_at: new Date().toISOString()
      })
      .select('id,name,size,path,updated_at')
      .single();

    if (insertError) {
      throw new Error(insertError.message || '업로드 정보를 저장하지 못했습니다.');
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, file: inserted })
    };
  } catch (err) {
    console.error('[upload-cloud]', err);
    const message = err.message || '업로드에 실패했습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};

function sanitizeForKey(name){
  return String(name || '')
    .replace(/[\r\n]/g,'')
    .replace(/[<>"'`]/g,'')
    .replace(/[\\/]/g,'_');
}

function sanitizeName(name){
  return String(name || '')
    .replace(/[\r\n]/g,'')
    .replace(/[<>"'`]/g,'')
    .trim();
}

function splitName(name){
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, idx), ext: name.slice(idx) };
}

function uniqueName(desired, existingSet){
  const target = sanitizeName(desired) || '파일';
  const baseArray = Array.isArray(existingSet)
    ? existingSet
    : Array.from(existingSet || []);
  const lowerSet = new Set(baseArray.map(n => String(n || '').toLowerCase()));
  const { base, ext } = splitName(target);
  let candidate = target;
  let i = 1;
  while (lowerSet.has(candidate.toLowerCase())){
    candidate = `${base} (${i})${ext}`;
    i++;
  }
  return candidate;
}

function normalizeFolder(path){
  if(!path) return '';
  return String(path)
    .split('/')
    .map(seg=>sanitizeForKey(seg).trim())
    .filter(Boolean)
    .join('/');
}

function extractFolderPath(path, userId){
  const withoutUser = path.startsWith(`${userId}/`) ? path.slice(userId.length + 1) : path;
  const segments = withoutUser.split('/').filter(Boolean);
  if (!segments.length) return '';
  if (segments[segments.length - 1] === '__folder__') {
    return segments.slice(0, -1).join('/');
  }
  return segments.slice(0, -1).join('/');
}

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}
