const supabaseAdmin = require('./supabaseAdmin');

async function authorize(event) {
  if (!supabaseAdmin) {
    throw new Error('Supabase 서비스 키가 설정되지 않았습니다.');
  }

  const header = event.headers?.authorization || event.headers?.Authorization;
  let token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    try {
      const body = JSON.parse(event.body || '{}');
      token = body.authToken;
    } catch {
      // ignore
    }
  }

  if (!token) {
    throw new Error('인증 토큰이 필요합니다.');
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error('토큰이 유효하지 않습니다.');
  }

  return data.user;
}

module.exports = authorize;
