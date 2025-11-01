require('./_shared/loadEnv');
const { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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

function sanitize(name){
  return String(name || '')
    .replace(/[\\r\\n]/g,'')
    .replace(/[<>"'`]/g,'')
    .replace(/[\\\/]/g,'_');
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
    const { id, path, newName, type } = body;

    if (!id || !path || !newName) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'이름 변경 정보가 부족합니다.' })
      };
    }

    const cleanName = sanitize(newName);
    if (!cleanName) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'유효한 파일명이 아닙니다.' })
      };
    }

    const isFolder = type === 'folder' || path.endsWith('/__folder__');

    if (isFolder) {
      const segments = path.split('/');
      if (segments.length < 3) throw new Error('잘못된 파일 경로입니다.');
      segments.pop(); // __folder__
      const oldFolderName = segments.pop();
      const parentSegments = segments;
      const parentPath = parentSegments.join('/');
      const oldPrefix = [...parentSegments, oldFolderName].join('/');
      const newPrefix = [...parentSegments, cleanName].join('/');

      const oldPrefixWithSlash = oldPrefix ? `${oldPrefix}/` : '';
      const newPrefixWithSlash = newPrefix ? `${newPrefix}/` : '';

      await copyObjectsByPrefix(oldPrefixWithSlash, newPrefixWithSlash);
      await deleteObjectsByPrefix(oldPrefixWithSlash);

      const { data: rows, error: rowsError } = await supabaseAdmin
        .from('cloud_files')
        .select('id,path,name')
        .eq('owner', user.id)
        .like('path', `${oldPrefix}%`);
      if (rowsError) throw new Error(rowsError.message || '폴더 정보를 업데이트하지 못했습니다.');

      for (const row of rows || []) {
        const newPath = row.path.replace(oldPrefix, newPrefix);
        const updates = {
          path: newPath,
          name: row.path.endsWith('/__folder__') ? newName : row.name,
          updated_at: new Date().toISOString()
        };
        await supabaseAdmin
          .from('cloud_files')
          .update(updates)
          .eq('id', row.id)
          .eq('owner', user.id);
      }

      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:true, path: `${newPrefix}/__folder__`, folderPath: newPrefix })
      };
    }

    const segments = path.split('/');
    if (segments.length < 2) {
      throw new Error('잘못된 파일 경로입니다.');
    }
    const originalFile = segments.pop();
    const prefixMatch = originalFile.match(/^(\d+)_/);
    const prefix = prefixMatch ? prefixMatch[1] : String(Date.now());
    const newFileName = `${prefix}_${cleanName}`;
    const newKey = [...segments, newFileName].join('/');

    const copySource = `${R2_BUCKET_CLOUD}/${encodeURIComponent(path).replace(/%2F/g,'/')}`;

    await r2Client.send(new CopyObjectCommand({
      Bucket: R2_BUCKET_CLOUD,
      CopySource: copySource,
      Key: newKey
    }));

    await r2Client.send(new DeleteObjectCommand({
      Bucket: R2_BUCKET_CLOUD,
      Key: path
    }));

    await supabaseAdmin
      .from('cloud_files')
      .update({
        name: newName,
        path: newKey,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('owner', user.id);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, path:newKey })
    };
  } catch (err) {
    console.error('[rename-cloud]', err);
    const message = err.message || '이름 변경에 실패했습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};

async function copyObjectsByPrefix(oldPrefix, newPrefix){
  if (!r2Client) return;
  let continuationToken;
  do {
    const listParams = {
      Bucket: R2_BUCKET_CLOUD,
      Prefix: oldPrefix,
      ContinuationToken: continuationToken
    };
    const listResp = await r2Client.send(new ListObjectsV2Command(listParams));
    const objects = listResp.Contents || [];
    for (const obj of objects){
      const oldKey = obj.Key;
      const suffix = oldKey.slice(oldPrefix.length);
      const newKey = `${newPrefix}${suffix}`;
      await r2Client.send(new CopyObjectCommand({
        Bucket: R2_BUCKET_CLOUD,
        CopySource: `${R2_BUCKET_CLOUD}/${encodeURIComponent(oldKey).replace(/%2F/g,'/')}`,
        Key: newKey
      }));
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : null;
  } while (continuationToken);
}

async function deleteObjectsByPrefix(prefix){
  if (!r2Client) return;
  let continuationToken;
  do {
    const listParams = {
      Bucket: R2_BUCKET_CLOUD,
      Prefix: prefix,
      ContinuationToken: continuationToken
    };
    const listResp = await r2Client.send(new ListObjectsV2Command(listParams));
    const objects = listResp.Contents || [];
    if (objects.length > 0) {
      await r2Client.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET_CLOUD,
        Delete: {
          Objects: objects.map(obj => ({ Key: obj.Key }))
        }
      }));
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : null;
  } while (continuationToken);
}
