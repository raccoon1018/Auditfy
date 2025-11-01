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
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
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

async function fetchAllUsers(){
  const users=[];
  let page=1;
  while(true){
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if(error) throw error;
    if(!data?.users?.length) break;
    users.push(...data.users);
    if(!data.nextPage) break;
    page = data.nextPage;
  }
  return users;
}

function buildUsageMap(rows){
  const map = new Map();
  for(const row of rows || []){
    const owner = row.owner || row.user || row.created_by;
    if(!owner) continue;
    const size = Number(row.size) || 0;
    map.set(owner, (map.get(owner) || 0) + size);
  }
  return map;
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
    const operator = await authorize(event);
    if (!isSuper(operator)) {
      return { statusCode: 403, headers: corsHeaders(), body: JSON.stringify({ ok:false, error:'슈퍼관리자 권한이 필요합니다.' }) };
    }

    const users = await fetchAllUsers();

    const cloudQuery = await supabaseAdmin
      .from('cloud_files')
      .select('owner,size');
    let cloudMap = new Map();
    if (cloudQuery.error) {
      if (!isRelationMissing(cloudQuery.error)) throw cloudQuery.error;
    } else {
      cloudMap = buildUsageMap(cloudQuery.data);
    }

    const projectQuery = await supabaseAdmin
      .from('project_files')
      .select('owner,size');
    let projectMap = new Map();
    if (projectQuery.error) {
      if (!isRelationMissing(projectQuery.error)) throw projectQuery.error;
    } else {
      projectMap = buildUsageMap(projectQuery.data);
    }

    const results = users.map(user => {
      const meta = user.user_metadata || {};
      const cloudBytes = cloudMap.get(user.id) || 0;
      const projBytes = projectMap.get(user.id) || 0;
      return {
        id: user.id,
        email: user.email,
        name: meta.name || user.email?.split('@')[0] || '사용자',
        plan: meta.plan || 'Free',
        role: meta.role || (SUPER_ADMINS.includes(String(user.email||'').toLowerCase()) ? 'super' : 'user'),
        planExpiresAt: meta.planExpiresAt || null,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at,
        cloudBytes,
        projectBytes: projBytes,
        totalBytes: cloudBytes + projBytes
      };
    });

    const totalUsage = results.reduce((acc, cur) => acc + cur.totalBytes, 0);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:true, users: results, totalBytes: totalUsage })
    };
  } catch (err) {
    console.error('[list-users-with-usage]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok:false, error: err.message || '사용자 정보를 불러올 수 없습니다.' })
    };
  }
};
