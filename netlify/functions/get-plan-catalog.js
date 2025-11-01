require('./_shared/loadEnv');
const authorize = require('./_shared/authorize');
const supabaseAdmin = require('./_shared/supabaseAdmin');

const MB = 1024 * 1024;

const catalog = [
  {
    id: 'Free',
    label: 'Free',
    description: '취미 및 테스트 용도에 적합한 무료 플랜',
    quotas: {
      projectBytes: 20 * MB,
      cloudBytes: 30 * MB
    },
    pricing: {
      currency: 'KRW',
      monthly: 0,
      usdMonthly: 0
    },
    perks: [
      '프로젝트 저장소 20MB 제공',
      'Auditfy Cloud 30MB 제공',
      '이메일 지원 (48시간 이내 응답)',
      '기본 내보내기 품질'
    ]
  },
  {
    id: 'Plus',
    label: 'Plus',
    description: '크리에이터를 위한 확장 스토리지와 향상된 지원',
    quotas: {
      projectBytes: 50 * MB,
      cloudBytes: 250 * MB
    },
    pricing: {
      currency: 'KRW',
      monthly: 9900,
      usdMonthly: 8
    },
    perks: [
      '프로젝트 저장소 50MB 제공',
      'Auditfy Cloud 250MB 제공',
      '우선 지원 (24시간 이내 응답)',
      '고급 내보내기 프리셋' 
    ]
  },
  {
    id: 'Pro',
    label: 'Pro',
    description: '스튜디오 및 팀 협업에 최적화된 전문가용 플랜',
    quotas: {
      projectBytes: 100 * MB,
      cloudBytes: 400 * MB
    },
    pricing: {
      currency: 'KRW',
      monthly: 19900,
      usdMonthly: 16
    },
    perks: [
      '프로젝트 저장소 100MB 제공',
      'Auditfy Cloud 400MB 제공',
      '프리미엄 지원 (12시간 이내 응답)',
      '전문가용 마스터링 도구'
    ]
  }
];

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json'
  };
}

function isRelationMissing(error){
  return error && /does not exist/i.test(error.message || '');
}

function mapRowToPlan(row){
  const projectBytes = Number(row.project_bytes || row.projectBytes || 0);
  const cloudBytes = Number(row.cloud_bytes || row.cloudBytes || 0);
  const monthly = Number(row.price_monthly || row.priceMonthly || 0);
  const usdMonthly = Number(row.price_usd_monthly || row.priceUsdMonthly || 0);
  let perks = [];
  if(Array.isArray(row.perks)) perks = row.perks;
  else if(typeof row.perks === 'string'){
    try{ const parsed = JSON.parse(row.perks); if(Array.isArray(parsed)) perks = parsed; }
    catch{ perks = row.perks.split('\n').map(v=>v.trim()).filter(Boolean); }
  }
  return {
    id: row.id,
    label: row.label,
    description: row.description || '',
    quotas: {
      projectBytes: projectBytes || 0,
      cloudBytes: cloudBytes || 0
    },
    pricing: {
      currency: row.currency || 'KRW',
      monthly,
      usdMonthly
    },
    perks
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
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' })
    };
  }

  try {
    await authorize(event);

    if (supabaseAdmin) {
      try {
        const { data, error } = await supabaseAdmin
          .from('plan_catalog')
          .select('id,label,description,project_bytes,cloud_bytes,price_monthly,price_usd_monthly,currency,perks')
          .order('id');
        if (error) {
          if (!isRelationMissing(error)) throw error;
        } else if (Array.isArray(data) && data.length) {
          const plans = data.map(mapRowToPlan);
          return {
            statusCode: 200,
            headers: corsHeaders(),
            body: JSON.stringify({ ok: true, plans, updatedAt: new Date().toISOString(), source: 'table' })
          };
        }
      } catch (err) {
        console.warn('[get-plan-catalog] table fetch failed', err.message);
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, plans: catalog, updatedAt: new Date().toISOString(), source: 'default' })
    };
  } catch (err) {
    console.error('[get-plan-catalog]', err);
    const message = err.message || '플랜 정보를 불러올 수 없습니다.';
    const status = message.includes('인증') ? 401 : 500;
    return {
      statusCode: status,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: message })
    };
  }
};
