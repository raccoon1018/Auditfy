require('./_shared/loadEnv');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const r2Client = require('./_shared/r2Client');
const supabaseAdmin = require('./_shared/supabaseAdmin');
const authorize = require('./_shared/authorize');

const { R2_BUCKET_PROJECTS } = process.env;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: 'OK' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' })
    };
  }

  if (!r2Client || !supabaseAdmin || !R2_BUCKET_PROJECTS) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: 'R2 또는 Supabase 설정이 필요합니다.' })
    };
  }

  try {
    const user = await authorize(event);
    const body = JSON.parse(event.body || '{}');
    const { fileName, fileBase64, mimeType, projectId, projectName } = body;

    if (!fileName || !fileBase64) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok: false, error: '파일 정보가 부족합니다.' })
      };
    }

    const buffer = Buffer.from(fileBase64, 'base64');
    const desiredDisplayName = sanitizeName(projectName) || sanitizeName(fileName) || '프로젝트';

    let existingRecord = null;
    if (projectId) {
      const { data: record, error: recordError } = await supabaseAdmin
        .from('project_files')
        .select('id,display_name,name,file_name,file_path,path')
        .eq('id', projectId)
        .eq('owner', user.id)
        .maybeSingle();
      if (recordError) throw new Error(recordError.message || '기존 프로젝트 정보를 불러올 수 없습니다.');
      existingRecord = record || null;
    }

    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('project_files')
      .select('id,display_name,name')
      .eq('owner', user.id);
    if (existingError) throw new Error(existingError.message || '프로젝트 목록을 불러올 수 없습니다.');

    const existingNames = new Set((existingRows || [])
      .filter(row => !projectId || row.id !== projectId)
      .map(row => String(row.display_name || row.name || '').trim().toLowerCase())
      .filter(Boolean));

    const finalDisplayName = existingRecord
      ? desiredDisplayName
      : uniqueName(desiredDisplayName, existingNames);

    let key = existingRecord?.file_path || existingRecord?.path;
    if (!key) {
      key = `${user.id}/${Date.now()}_${sanitizeForKey(finalDisplayName)}.zip`;
    }

    const fileNameStored = `${sanitizeForKey(finalDisplayName)}.zip`;

    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_PROJECTS,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/zip'
    }));

    const payload = {
      owner: user.id,
      display_name: finalDisplayName,
      name: finalDisplayName,
      file_name: fileNameStored,
      file_path: key,
      path: key,
      size: buffer.length,
      updated_at: new Date().toISOString()
    };

   let saved;
   if (projectId) {
     payload.id = projectId;
     const { data, error } = await supabaseAdmin
        .from('project_files')
        .upsert(payload, { onConflict: 'id' })
        .select('id,display_name,name,file_name,file_path,updated_at,size')
        .single();
     if (error) throw new Error(error.message || '프로젝트 정보를 저장하지 못했습니다.');
     saved = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('project_files')
        .insert(payload)
        .select('id,display_name,name,file_name,file_path,updated_at,size')
        .single();
      if (error) throw new Error(error.message || '프로젝트 정보를 저장하지 못했습니다.');
      saved = data;
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, project: normalizeProjectRow(saved) })
    };
  } catch (err) {
    console.error('[upload-project]', err);
    const message = err.message || '업로드에 실패했습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: message })
    };
  }
};

function sanitizeName(name){
  const str = String(name || '').replace(/[\r\n]/g,'').replace(/[<>"'`]/g,'').trim();
  return str || '프로젝트';
}

function sanitizeForKey(name){
  return sanitizeName(name).replace(/[\\/]/g,'_');
}

function splitName(name){
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, idx), ext: name.slice(idx) };
}

function uniqueName(desired, existingSet){
  const target = sanitizeName(desired) || '프로젝트';
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

function normalizeProjectRow(row){
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name || row.name || row.file_name,
    file_name: row.file_name || row.name,
    file_path: row.file_path || row.path,
    updated_at: row.updated_at,
    size: row.size || 0
  };
}

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}
