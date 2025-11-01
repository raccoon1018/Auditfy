const path = require('path');
const fs = require('fs');

const candidatePaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '..', '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env')
];

const envPath = candidatePaths.find((p) => fs.existsSync(p));

if (envPath) {
    require('dotenv').config({ path: envPath });
} else {
    console.warn('[Env] .env 파일을 찾을 수 없어 기본 환경변수를 사용합니다.');
}
