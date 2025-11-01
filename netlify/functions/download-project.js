require('./_shared/loadEnv');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const r2Client = require('./_shared/r2Client');
const supabaseAdmin = require('./_shared/supabaseAdmin');
const authorize = require('./_shared/authorize');

const { R2_BUCKET_PROJECTS } = process.env;

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

  if (!r2Client || !supabaseAdmin || !R2_BUCKET_PROJECTS) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error:'R2 또는 Supabase 설정이 필요합니다.' })
    };
  }

  try {
    const user = await authorize(event);
    const body = JSON.parse(event.body || '{}');
    const projectId = String(body.projectId || '').trim();
    if (!projectId) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'projectId가 필요합니다.' })
      };
    }

    const { data: record, error: recordError } = await supabaseAdmin
      .from('project_files')
      .select('id,owner,display_name,name,file_path,path')
      .eq('id', projectId)
      .eq('owner', user.id)
      .maybeSingle();

    if (recordError) {
      throw new Error(recordError.message || '프로젝트 정보를 불러올 수 없습니다.');
    }
    if (!record) {
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'프로젝트를 찾을 수 없습니다.' })
      };
    }

    const key = record.file_path || record.path;
    if (!key) {
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({ ok:false, error:'프로젝트 파일 경로가 없습니다.' })
      };
    }

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_PROJECTS,
      Key: key
    });
    const url = await getSignedUrl(r2Client, command, { expiresIn: 300 });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        url,
        name: record.display_name || record.name || 'auditfy_project',
        fileName: record.file_name || record.name,
        project: normalizeProjectRow(record)
      })
    };
  } catch (err) {
    console.error('[download-project]', err);
    const message = err.message || '프로젝트를 다운로드할 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: message })
    };
  }
};

function normalizeProjectRow(row){
  if(!row) return null;
  return {
    id: row.id,
    display_name: row.display_name || row.name,
    file_name: row.file_name || row.name,
    file_path: row.file_path || row.path || '',
    updated_at: row.updated_at,
    size: row.size || 0
  };
}
