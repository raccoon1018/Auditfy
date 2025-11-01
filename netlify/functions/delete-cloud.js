require('./_shared/loadEnv');
const { DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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
    const { id, path, type } = body;

    if (!id || !path) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'삭제할 항목 정보가 필요합니다.' })
      };
    }

    const isFolder = type === 'folder' || path.endsWith('/__folder__');

    if (isFolder) {
      const prefix = path.replace(/__folder__$/, '');
      await deleteObjectsByPrefix(prefix);

      const { data: rows, error: rowsError } = await supabaseAdmin
        .from('cloud_files')
        .select('id')
        .eq('owner', user.id)
        .like('path', `${prefix}%`);
      if (rowsError) throw new Error(rowsError.message || '폴더 정보 삭제에 실패했습니다.');
      if (rows?.length) {
        await supabaseAdmin
          .from('cloud_files')
          .delete()
          .in('id', rows.map(r => r.id))
          .eq('owner', user.id);
      }
    } else {
      await r2Client.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET_CLOUD,
        Key: path
      }));

      await supabaseAdmin
        .from('cloud_files')
        .delete()
        .eq('id', id)
        .eq('owner', user.id);
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true })
    };
  } catch (err) {
    console.error('[delete-cloud]', err);
    const message = err.message || '삭제에 실패했습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};

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
      const deleteParams = {
        Bucket: R2_BUCKET_CLOUD,
        Delete: {
          Objects: objects.map(obj => ({ Key: obj.Key }))
        }
      };
      await r2Client.send(new DeleteObjectsCommand(deleteParams));
    }
    continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : null;
  } while (continuationToken);
}
