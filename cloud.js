(function (global) {
  'use strict';

  /**
   * 설정 값은 전역 객체 __AUDITFY_SUPABASE__ 로 주입하거나
   * 아래 DEFAULT_CONFIG 를 직접 수정해 사용할 수 있습니다.
   */
  const DEFAULT_CONFIG = {
    url: 'https://edmstrrqstmawvqjgkih.supabase.co',          // TODO: Supabase Project URL 로 교체
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkbXN0cnJxc3RtYXd2cWpna2loIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkzMTk0MzksImV4cCI6MjA3NDg5NTQzOX0.h1sdDt7YqB_IbH82cnLhQjHA0Se5CQ4BvnrFFZ6X-0s',                         // TODO: Supabase anon 키로 교체
    superAdmins: ['yoon080708@gmail.com'],            // 슈퍼관리자 이메일 목록
    masterKey: '1018'                                 // 슈퍼관리자 페이지 접근용 패스워드
  };

  const config = Object.assign({}, DEFAULT_CONFIG, global.__AUDITFY_SUPABASE__ || {});
  const SUPER_ADMINS = new Set((config.superAdmins || []).map(e => String(e || '').toLowerCase()));
  const MASTER_KEY = String(config.masterKey || '1018');

  let clientPromise = null;

  function ensureConfig() {
    if (!config.url || config.url.includes('YOUR-PROJECT')) {
      console.warn('[Cloud] SUPABASE URL 이 설정되지 않았습니다. cloud.js 상단의 DEFAULT_CONFIG 를 수정하세요.');
    }
    if (!config.anonKey || config.anonKey.includes('YOUR_ANON_KEY')) {
      console.warn('[Cloud] SUPABASE anonKey 가 설정되지 않았습니다. cloud.js 상단의 DEFAULT_CONFIG 를 수정하세요.');
    }
  }

  async function getClient() {
    ensureConfig();
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      if (!global.supabase) {
        throw new Error('Supabase SDK가 페이지에 로드되지 않았습니다. HTML에 supabase-js 스크립트를 추가했는지 확인하세요.');
      }
      return global.supabase.createClient(config.url, config.anonKey);
    })();
    return clientPromise;
  }

  function normalizeUser(user) {
    if (!user) return null;
    const email = user.email || '';
    const meta = user.user_metadata || {};
    const role = meta.role || (SUPER_ADMINS.has(email.toLowerCase()) ? 'super' : 'user');
    return {
      id: user.id,
      email,
      name: meta.name || email.split('@')[0] || '사용자',
      plan: meta.plan || 'Free',
      planExpiresAt: meta.planExpiresAt || null,
      role
    };
  }

  async function requireUser() {
    const client = await getClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) throw new Error('로그인이 필요합니다.');
    return { client, user: data.user };
  }

  async function getAccessToken() {
    const client = await getClient();
    const { data } = await client.auth.getSession();
    return data?.session?.access_token || null;
  }

  function normalizeDir(pathArr) {
    return (pathArr || [])
      .map(seg => String(seg || '').trim())
      .filter(seg => seg && seg !== '.' && seg !== '..')
      .join('/');
  }

  const entryIndex = new Map();
  function makeIndexKey(dir, name) {
    return `${dir || ''}::${name}`;
  }
  function setIndex(dir, name, value) {
    entryIndex.set(makeIndexKey(dir, name), value);
  }
  function getIndex(dir, name) {
    return entryIndex.get(makeIndexKey(dir, name));
  }
  function clearIndex(dir) {
    const prefix = `${dir || ''}::`;
    for (const key of Array.from(entryIndex.keys())) {
      if (key.startsWith(prefix)) entryIndex.delete(key);
    }
  }

  const entryById = new Map();
  function rememberEntry(entry) {
    if (entry && entry.id) {
      entryById.set(entry.id, entry);
    }
  }
  function forgetEntry(id) {
    if (id) entryById.delete(id);
  }
  function pathStringToArray(path) {
    return String(path || '')
      .split('/')
      .map(seg => seg.trim())
      .filter(seg => seg && seg !== '.');
  }
  function normalizeProjectRow(row){
    if(!row) return null;
    const displayName = row.display_name || row.name || row.file_name || '프로젝트';
    return {
      id: row.id,
      displayName,
      name: displayName,
      fileName: row.file_name || row.name || '',
      filePath: row.file_path || row.path || '',
      updated: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
      size: row.size || 0
    };
  }

  function uniqueProjectName(desired, existingSet){
    const target = String(desired || '').trim() || '프로젝트';
    const baseArray = Array.isArray(existingSet)
      ? existingSet
      : Array.from(existingSet || []);
    const lowerSet = new Set(baseArray.map(n => String(n || '').toLowerCase()));
    let candidate = target;
    let i = 1;
    while (lowerSet.has(candidate.toLowerCase())) {
      candidate = `${target} (${i})`;
      i++;
    }
    return candidate;
  }

  function isUuid(value){
    return typeof value === 'string' && UUID_RE.test(value);
  }
  function getEntryById(id) {
    return entryById.get(id);
  }

  async function authFetch(path, { method = 'GET', body, headers = {} } = {}) {
    const token = await getAccessToken();
    if (!token) throw new Error('로그인이 필요합니다.');
    const init = { method, headers: Object.assign({}, headers, { Authorization: `Bearer ${token}` }) };
    if (method !== 'GET' && body !== undefined) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    let json;
    if (contentType.includes('application/json')) {
      try { json = text ? JSON.parse(text) : {}; }
      catch { json = { ok: false, error: '서버 응답을 해석하지 못했습니다.' }; }
    } else {
      json = { ok: false, error: 'Cloud API가 JSON이 아닌 응답을 반환했습니다. Netlify Functions 서버가 실행 중인지 확인해주세요.' };
    }
    if (!res.ok || json?.ok === false) {
      const message = json?.error || `요청에 실패했습니다. (HTTP ${res.status})`;
      throw new Error(message);
    }
    return json;
  }

  const FOLDER_MARKER='__folder__';
  const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  /* ================= Auth ================= */

  async function register({ email, password, name, birthday, kind }) {
    const body = { email, password, name, birthday, kind };

    let metadataFromServer = null;
    try {
      const resp = await fetch('/.netlify/functions/register-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const contentType = resp.headers.get('content-type') || '';
      const text = await resp.text();
      if (!contentType.includes('application/json')) {
        throw new Error('Cloud 함수 응답이 JSON이 아닙니다. Netlify Functions 서버가 실행 중인지 확인해주세요.');
      }
      const json = text ? JSON.parse(text) : {};
      if (!resp.ok || json?.ok === false) {
        throw new Error(json?.error || `회원가입 사전 검증 실패 (HTTP ${resp.status})`);
      }
      metadataFromServer = json.metadata || null;
    } catch (err) {
      console.warn('[Cloud.register] register-user function failed', err);
      const message = err?.message || '';
      // Functions가 중단된 경우에는 fallback으로 Supabase signUp을 시도하되,
      // 명확한 오류(이미 가입된 이메일 등)는 즉시 반환하여 중복 가입을 막는다.
      if (!message || /Cloud 함수 응답이 JSON이 아닙니다/.test(message) || /Netlify Functions/.test(message)) {
        // continue to Supabase signUp fallback
      } else {
        return { ok: false, error: message };
      }
    }

    try {
      const client = await getClient();
      const meta = Object.assign({
        name: name || metadataFromServer?.suggestedName || email.split('@')[0],
        plan: 'Free',
        birthday: birthday || '',
        kind: kind || 'personal',
        role: metadataFromServer?.role || (SUPER_ADMINS.has(String(email || '').toLowerCase()) ? 'super' : 'user')
      }, metadataFromServer || {});

      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${location.origin}/auth.html`,
          data: meta
        }
      });
      if (error) {
        const msg = formatSupabaseError(error.message);
        return { ok: false, error: msg };
      }
      const pending = !data?.session;
      return { ok: true, pendingEmailConfirmation: pending };
    } catch (err) {
      console.error('[Cloud.register] signUp failed', err);
      return { ok: false, error: formatSupabaseError(err.message || '회원가입에 실패했습니다.') };
    }
  }

  function formatSupabaseError(message){
    if(!message) return '요청을 처리할 수 없습니다.';
    if(/already registered/i.test(message)) return '이미 가입된 이메일입니다. 로그인 또는 비밀번호 찾기를 이용해주세요.';
    if(/invalid/i.test(message) && /email/i.test(message)) return '유효한 이메일 주소를 입력해주세요.';
    if(/rate limit/i.test(message)) return '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.';
    if(/password should be at least/i.test(message)) return '비밀번호는 8자 이상이어야 합니다.';
    return message;
  }

  async function login({ email, password }) {
    const client = await getClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = /email not confirmed/i.test(error.message)
        ? '이메일 인증이 완료되지 않았습니다. 받은 편지함을 확인해주세요.'
        : error.message;
      return { ok: false, error: msg };
    }
    return { ok: true, user: normalizeUser(data.user) };
  }

  async function logout() {
    const client = await getClient();
    await client.auth.signOut();
  }

  async function session() {
    const client = await getClient();
    const { data } = await client.auth.getUser();
    return normalizeUser(data.user);
  }

  async function updateProfile(patch) {
    try {
      const { client, user } = await requireUser();
      const meta = Object.assign({}, user.user_metadata || {});
      if (typeof patch.name === 'string') meta.name = patch.name;
      if (typeof patch.plan === 'string') {
        const emailLower = String(user.email || '').toLowerCase();
        const roleLower = String(user.user_metadata?.role || '').toLowerCase();
        if (SUPER_ADMINS.has(emailLower) || roleLower === 'super') {
          meta.plan = patch.plan;
        }
      }
      const { error, data } = await client.auth.updateUser({ data: meta });
      if (error) return { ok: false, error: error.message };
      return { ok: true, user: normalizeUser(data.user) };
    } catch (err) {
      return { ok: false, error: err.message || '프로필 업데이트 실패' };
    }
  }

  function requireMasterKey(email) {
    const lower = String(email || '').toLowerCase();
    return SUPER_ADMINS.has(lower);
  }

  function verifyMasterKey(key) {
    return String(key || '') === MASTER_KEY;
  }

  function setRole() {
    return { ok: false, error: '슈퍼 관리자 권한 변경은 서버에서 구현해야 합니다.' };
  }

  async function forgotPassword(email) {
    try {
      const response = await fetch('/.netlify/functions/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const result = await response.json();
      return result;
    } catch (err) {
      return { ok: false, error: err.message || '임시 비밀번호 발급에 실패했습니다.' };
    }
  }

  function resetPassword() {
    return { ok: false, error: '임시 비밀번호 발급 방식을 사용하세요.' };
  }

  /* ================= Project Store ================= */

  const ProjectsAPI = {
    async list() {
      try {
        const { client } = await requireUser();
        const { data, error } = await client
          .from('project_files')
          .select('id,display_name,name,file_name,file_path,updated_at,size')
          .order('updated_at', { ascending: false });
        if (error) return { ok: false, error: error.message };
        const items = (data || []).map(normalizeProjectRow);
        return { ok: true, items };
      } catch (err) {
        return { ok: false, error: err.message || '프로젝트 목록을 불러올 수 없습니다.' };
      }
    },
    async create({ name }) {
      try {
        const { client, user } = await requireUser();
        const desired = name?.trim() || 'Untitled';
        const { data: existingRows, error: existingError } = await client
          .from('project_files')
          .select('display_name,name')
          .eq('owner', user.id);
        if (existingError) return { ok: false, error: existingError.message };
        const existingNames = new Set((existingRows || [])
          .map(row => String(row.display_name || row.name || '').trim().toLowerCase())
          .filter(Boolean));
        const finalName = uniqueProjectName(desired, existingNames);
        const payload = {
          owner: user.id,
          display_name: finalName,
          name: finalName,
          file_name: '',
          file_path: '',
          path: '',
          size: 0
        };
        const { data, error } = await client
          .from('project_files')
          .insert(payload)
          .select('id,display_name,name,file_name,file_path,updated_at,size')
          .single();
        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          project: normalizeProjectRow(data)
        };
      } catch (err) {
        return { ok: false, error: err.message || '프로젝트 생성에 실패했습니다.' };
      }
    },
    async rename(id, newName) {
      try {
        const { client } = await requireUser();
        const { data, error } = await client
          .from('project_files')
          .update({ display_name: newName, name: newName })
          .eq('id', id)
          .select('id,display_name,name,file_name,file_path,updated_at,size')
          .single();
        if (error) return { ok: false, error: error.message };
        return {
          ok: true,
          project: normalizeProjectRow(data)
        };
      } catch (err) {
        return { ok: false, error: err.message || '프로젝트 이름을 변경할 수 없습니다.' };
      }
    },
    async remove(id) {
      try {
        const { client } = await requireUser();
        const { error } = await client
          .from('project_files')
          .delete()
          .eq('id', id);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || '프로젝트를 삭제할 수 없습니다.' };
      }
    },
    async saveZip({ id, name, blob }) {
      try {
        const base64 = await blobToBase64(blob);
        const body = {
          fileName: name,
          fileBase64: base64,
          mimeType: 'application/zip',
          projectId: isUuid(id) ? id : undefined,
          projectName: name
        };
        const resp = await authFetch('/.netlify/functions/upload-project', {
          method: 'POST',
          body
        });
        if(resp?.project) resp.project = normalizeProjectRow(resp.project);
        return resp;
      } catch (err) {
        console.error('[Cloud.projects.saveZip]', err);
        return { ok: false, error: err.message || '프로젝트를 저장할 수 없습니다.' };
      }
    }
  };

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const base64 = String(result).split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error('파일을 읽을 수 없습니다.'));
      reader.readAsDataURL(blob);
    });
  }

  async function findEntry(dir, name) {
    const cached = getIndex(dir, name);
    if (cached) return cached;
    try {
      const { client, user } = await requireUser();
      const prefix = `${user.id}/${dir ? `${dir}/` : ''}`;
      const { data, error } = await client
        .from('cloud_files')
        .select('id,display_name,name,size,path,updated_at')
        .eq('owner', user.id)
        .eq('name', name)
        .like('path', `${prefix}%`)
        .limit(1);
      if (error) throw error;
      const entry = data && data[0];
      if (!entry) return null;
      if (entry.path?.endsWith(`/${FOLDER_MARKER}`)) {
        const folderEntry = {
          type: 'folder',
          id: entry.id,
          name: entry.display_name || entry.name,
          path: (dir ? `${dir}/` : '') + (entry.display_name || entry.name),
          markerPath: entry.path,
          dir
        };
        setIndex(dir, folderEntry.name, folderEntry);
        rememberEntry(folderEntry);
        return folderEntry;
      }
      const fileEntry = {
        type: 'file',
        id: entry.id,
        name: entry.display_name || entry.name,
        path: entry.path,
        dir,
        size: entry.size || 0,
        modified: entry.updated_at || null
      };
      setIndex(dir, fileEntry.name, fileEntry);
      rememberEntry(fileEntry);
      return fileEntry;
    } catch (err) {
      console.warn('[Cloud.fs] 항목 조회 실패', err);
      return null;
    }
  }

  const CloudFS = {
    async list(pathArr) {
      const dir = normalizeDir(pathArr);
      try {
        const { user } = await requireUser();
        const { items } = await authFetch('/.netlify/functions/list-cloud');
        clearIndex(dir);
        const prefix = `${user.id}/`;
        const currentPath = dir;
        const currentSegments = currentPath ? currentPath.split('/') : [];
        const folders = new Map();
        const files = [];
        entryById.clear();

        (items || []).forEach(row => {
          const key = row?.path || '';
          if (!key.startsWith(prefix)) return;
          const remainder = key.slice(prefix.length).replace(/^\/+/, '');
          if (!remainder) return;
          const segments = remainder.split('/').filter(Boolean);
          if (!segments.length) return;

          const lastSegment = segments[segments.length - 1];
          const isFolderRow = lastSegment === FOLDER_MARKER;

          if (isFolderRow) {
            const folderSegments = segments.slice(0, -1);
            if (!folderSegments.length) return;
            const parentPath = folderSegments.slice(0, -1).join('/');
            const folderName = row.name || folderSegments[folderSegments.length - 1];
            const folderEntry = {
              type: 'folder',
              name: folderName,
              modified: row.updated_at || null,
              path: folderSegments.join('/'),
              markerPath: row.path,
              id: row.id,
              dir: parentPath
            };
            rememberEntry(folderEntry);
            setIndex(parentPath, folderName, folderEntry);
            if ((parentPath || '') === (currentPath || '')) {
              folders.set(folderName, folderEntry);
            }
            return;
          }

          const folderSegments = segments.slice(0, -1);
          const folderPath = folderSegments.join('/');
          const fileName = row.name || lastSegment;
          const fileEntry = {
            type: 'file',
            name: fileName,
            size: Number(row.size) || 0,
            modified: row.updated_at || null,
            path: row.path,
            id: row.id,
            dir: folderPath,
            mime: row.mime || ''
          };
          rememberEntry(fileEntry);

          if (folderPath === currentPath) {
            files.push(fileEntry);
            setIndex(currentPath, fileEntry.name, fileEntry);
          } else {
            const currentLen = currentSegments.length;
            const matchesPrefix = currentPath === '' ? true : folderPath.startsWith(currentPath + '/');
            if (matchesPrefix) {
              const nextSeg = folderSegments[currentLen];
              if (nextSeg && !folders.has(nextSeg)) {
                folders.set(nextSeg, {
                  type: 'folder',
                  name: nextSeg,
                  modified: row.updated_at || null,
                  path: folderSegments.slice(0, currentLen + 1).join('/'),
                  id: `folder:${folderSegments.slice(0, currentLen + 1).join('/')}`
                });
              }
            }
          }
        });

        const folderItems = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        const fileItems = files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        return { ok: true, items: [...folderItems, ...fileItems] };
      } catch (err) {
        console.error('[Cloud.fs.list]', err);
        return { ok: false, error: err.message || 'Cloud 목록을 불러올 수 없습니다.' };
      }
    },
    async mkdir(pathArr, name) {
      try {
        const dir = normalizeDir(pathArr);
        const json = await authFetch('/.netlify/functions/mkdir-cloud', {
          method: 'POST',
          body: {
            parent: dir,
            name
          }
        });
        await refreshUsageInternal();
        return { ok: true, name: json.folder?.name || name };
      } catch (err) {
        console.error('[Cloud.fs.mkdir]', err);
        return { ok: false, error: err.message || '폴더를 생성할 수 없습니다.' };
      }
    },
    async upload(pathArr, file) {
      try {
        const dir = normalizeDir(pathArr);
        const base64 = await blobToBase64(file);
        const json = await authFetch('/.netlify/functions/upload-cloud', {
          method: 'POST',
          body: {
            fileName: file.name,
            fileBase64: base64,
            mimeType: file.type || 'application/octet-stream',
            folder: dir
          }
        });
        const info = json.file || {};
        const entry = {
          type: 'file',
          name: info.name || file.name,
          size: info.size || file.size,
          modified: info.updated_at || new Date().toISOString(),
          path: info.path || json.path,
          id: info.id,
          dir
        };
        rememberEntry(entry);
        await refreshUsageInternal();
        return { ok: true, name: entry.name, size: entry.size, path: entry.path, id: entry.id };
      } catch (err) {
        console.error('[Cloud.fs.upload]', err);
        return { ok: false, error: err.message || '업로드에 실패했습니다.' };
      }
    },
    async rename(pathArr, oldName, newName) {
      const dir = normalizeDir(pathArr);
      try {
        const entry = await findEntry(dir, oldName);
        if (!entry) return { ok: false, error: '파일을 찾을 수 없습니다.' };
        const json = await authFetch('/.netlify/functions/rename-cloud', {
          method: 'POST',
          body: { id: entry.id, path: entry.markerPath || entry.path, newName, type: entry.type }
        });
        entry.name = newName;
        if (entry.type === 'folder') {
          entry.markerPath = json.path || entry.markerPath;
          entry.path = json.folderPath || entry.path;
        } else {
          entry.path = json.path || entry.path;
        }
        entry.dir = dir;
        entryIndex.delete(makeIndexKey(dir, oldName));
        setIndex(dir, newName, entry);
        rememberEntry(Object.assign({}, entry, { dir }));
        await refreshUsageInternal();
        return { ok: true, name: newName, path: entry.path };
      } catch (err) {
        console.error('[Cloud.fs.rename]', err);
        return { ok: false, error: err.message || '이름을 변경할 수 없습니다.' };
      }
    },
    async remove(pathArr, name) {
      const dir = normalizeDir(pathArr);
      try {
        const entry = await findEntry(dir, name);
        if (!entry) return { ok: false, error: '파일을 찾을 수 없습니다.' };
        const isFolder = entry.type === 'folder' || entry.path === entry.markerPath;
        const targetPath = entry.markerPath || entry.path;
        await authFetch('/.netlify/functions/delete-cloud', {
          method: 'POST',
          body: { id: entry.id, path: targetPath, type: isFolder ? 'folder' : 'file' }
        });
        entryIndex.delete(makeIndexKey(dir, name));
        forgetEntry(entry.id);
        if (isFolder){
          const prefix = (entry.path || '').replace(/\/+$/, '');
          for (const [cacheId, cacheEntry] of entryById.entries()){
            if(cacheEntry.dir && (cacheEntry.dir === prefix || cacheEntry.dir.startsWith(prefix + '/'))){
              entryById.delete(cacheId);
            }
          }
        }
        await refreshUsageInternal();
        return { ok: true };
      } catch (err) {
        console.error('[Cloud.fs.remove]', err);
        return { ok: false, error: err.message || '삭제에 실패했습니다.' };
      }
    },
    async readFile(pathArr, name) {
      const dir = normalizeDir(pathArr);
      try {
        const entry = await findEntry(dir, name);
        if (!entry) return { ok: false, error: '파일을 찾을 수 없습니다.' };
        const { url } = await authFetch('/.netlify/functions/get-cloud-url', {
          method: 'POST',
          body: { path: entry.path }
        });
        const response = await fetch(url);
        if (!response.ok) throw new Error('파일을 다운로드할 수 없습니다.');
        const blob = await response.blob();
        return {
          ok: true,
          blob,
          mime: response.headers.get('Content-Type') || blob.type || 'application/octet-stream',
          size: blob.size,
          name
        };
      } catch (err) {
        console.error('[Cloud.fs.readFile]', err);
        return { ok: false, error: err.message || '파일을 불러올 수 없습니다.' };
      }
    }
  };
  CloudFS.allowsFolders = true;

  let usageCache = { ok: true, cloudBytes: 0, projBytes: 0 };
  let planCatalogCache = null;
  let planCatalogPromise = null;
  let announcementsCache = null;
  let bannerCache = null;

  async function fetchPlanCatalogInternal(force = false) {
    if (!force && planCatalogCache) return planCatalogCache;
    if (!planCatalogPromise) {
      planCatalogPromise = (async () => {
        const resp = await authFetch('/.netlify/functions/get-plan-catalog');
        const plans = Array.isArray(resp?.plans) ? resp.plans : [];
        planCatalogCache = {
          plans,
          updatedAt: resp?.updatedAt || null
        };
        return planCatalogCache;
      })()
        .catch(err => {
          planCatalogCache = null;
          throw err;
        })
        .finally(() => {
          planCatalogPromise = null;
        });
    }
    return planCatalogPromise;
  }

  function findPlanById(planId) {
    if (!planCatalogCache?.plans) return null;
    return planCatalogCache.plans.find(plan => (plan.id || '').toLowerCase() === String(planId || '').toLowerCase()) || null;
  }

  async function refreshUsageInternal() {
    try {
      const { client, user } = await requireUser();
      const cloudPromise = client
        .from('cloud_files')
        .select('size')
        .eq('owner', user.id);
      const projectPromise = client
        .from('project_files')
        .select('size')
        .eq('owner', user.id);

      const [cloudResult, projectResult] = await Promise.all([cloudPromise, projectPromise]);
      if (cloudResult.error) throw cloudResult.error;
      if (projectResult.error) throw projectResult.error;

      const cloudBytes = (cloudResult.data || []).reduce((sum, row) => sum + (Number(row.size) || 0), 0);
      const projBytes = (projectResult.data || []).reduce((sum, row) => sum + (Number(row.size) || 0), 0);

      usageCache = { ok: true, cloudBytes, projBytes };
    } catch (err) {
      usageCache = { ok: false, error: err.message || '용량 정보를 불러올 수 없습니다.' };
    }
    if (global.Cloud) global.Cloud.usage = usageCache;
    return usageCache;
  }

  async function callAuthed(path, body){
    try {
      const result = await authFetch(path, {
        method: 'POST',
        body
      });
      return result;
    } catch (err) {
      return { ok: false, error: err.message || '요청에 실패했습니다.' };
    }
  }

  async function fetchJson(path){
    try {
      const res = await fetch(path, { headers: { 'Content-Type':'application/json' } });
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      return { ok:false, error: err.message || '요청에 실패했습니다.' };
    }
  }

  async function adminUpdatePlan(payload){
    return callAuthed('/.netlify/functions/update-plan', payload);
  }

  async function adminCreateGiftCode(payload){
    return callAuthed('/.netlify/functions/create-gift-code', payload);
  }

  async function adminListGiftCodes(){
    try {
      const result = await authFetch('/.netlify/functions/list-gift-codes');
      return result;
    } catch (err) {
      return { ok: false, error: err.message || '기프트 코드를 불러올 수 없습니다.' };
    }
  }

  async function redeemGiftCodeRequest(code){
    return callAuthed('/.netlify/functions/redeem-gift-code', { code });
  }

  async function listAnnouncementsInternal(force=false){
    if(!force && announcementsCache) return announcementsCache;
    const resp = await fetchJson('/.netlify/functions/list-announcements');
    if(resp?.ok){
      announcementsCache = resp;
      bannerCache = resp.announcements?.find?.(a => a.is_banner);
    }
    return resp;
  }

  /* ================= Public API ================= */

  const Cloud = {
    init() {
      ensureConfig();
      // 미리 Supabase SDK 로드 시도
      getClient().catch(err => console.warn('[Cloud.init] Supabase 초기화 실패', err));
      refreshUsageInternal().catch(() => {});
    },
    register,
    login,
    logout,
    session,
    updateProfile,
    requireMasterKey,
    verifyMasterKey,
    setRole,
    forgotPassword,
    resetPassword,
    list(path='/') {
      return CloudFS.list(pathStringToArray(path));
    },
    mkdir(path, name) {
      return CloudFS.mkdir(pathStringToArray(path), name);
    },
    async upload(path, blob, name) {
      const arr = pathStringToArray(path);
      let fileObj = blob;
      if (!(blob instanceof File)) {
        const type = blob?.type || 'application/octet-stream';
        fileObj = new File([blob], name, { type });
      } else if (!blob.name && name) {
        fileObj = new File([blob], name, { type: blob.type || 'application/octet-stream' });
      }
      return CloudFS.upload(arr, fileObj);
    },
    async download(id) {
      const entry = getEntryById(id);
      if (!entry || entry.type === 'folder') throw new Error('파일을 찾을 수 없습니다.');
      const { url } = await authFetch('/.netlify/functions/get-cloud-url', {
        method: 'POST',
        body: { path: entry.markerPath || entry.path }
      });
      const response = await fetch(url);
      if (!response.ok) throw new Error('파일을 다운로드할 수 없습니다.');
      const blob = await response.blob();
      return {
        blob,
        name: entry.name,
        mime: response.headers.get('Content-Type') || blob.type || 'application/octet-stream',
        size: blob.size
      };
    },
    async rename(id, newName) {
      const entry = getEntryById(id);
      if (!entry) throw new Error('파일을 찾을 수 없습니다.');
      if (entry.type === 'folder') throw new Error('폴더 이름 변경은 아직 지원되지 않습니다.');
      const dirArr = pathStringToArray(entry.dir || '');
      const result = await CloudFS.rename(dirArr, entry.name, newName);
      if (!result?.ok) throw new Error(result?.error || '이름을 변경할 수 없습니다.');
      entry.name = result.name || newName;
      if (result.path) entry.path = result.path;
      rememberEntry(entry);
      return result;
    },
    async remove(id) {
      const entry = getEntryById(id);
      if (!entry) throw new Error('파일을 찾을 수 없습니다.');
      if (entry.type === 'folder') throw new Error('폴더 삭제는 아직 지원되지 않습니다.');
      const dirArr = pathStringToArray(entry.dir || '');
      const result = await CloudFS.remove(dirArr, entry.name);
      if (!result?.ok) throw new Error(result?.error || '삭제에 실패했습니다.');
      forgetEntry(id);
      return result;
    },
    async downloadProject(id) {
      const resp = await authFetch('/.netlify/functions/download-project', {
        method: 'POST',
        body: { projectId: id }
      });
      if(resp?.project) resp.project = normalizeProjectRow(resp.project);
      return resp;
    },
    projects: ProjectsAPI,
    fs: CloudFS,
    usage: usageCache,
    async planCatalog(options = {}) {
      try {
        const catalog = await fetchPlanCatalogInternal(options.force === true);
        return { ok: true, plans: catalog.plans, updatedAt: catalog.updatedAt };
      } catch (err) {
        console.error('[Cloud.planCatalog]', err);
        return { ok: false, error: err.message || '플랜 정보를 불러올 수 없습니다.' };
      }
    },
    planInfo(planId) {
      return findPlanById(planId);
    },
    quotaForPlan(planId) {
      const plan = findPlanById(planId);
      return plan?.quotas || null;
    },
    async redeemGiftCode(code) {
      if(!code) return { ok: false, error: '코드를 입력해주세요.' };
      return redeemGiftCodeRequest(code);
    },
    async listAnnouncements(options={}){
      const resp = await listAnnouncementsInternal(options.force === true);
      return resp;
    },
    announcementBanner(){
      return bannerCache;
    },
    async deleteAccount() {
      return callAuthed('/.netlify/functions/delete-account', {});
    },
    admin: {
      async updatePlan({ email, plan, expiresAt }) {
        if(!email || !plan) return { ok: false, error: '이메일과 플랜이 필요합니다.' };
        return adminUpdatePlan({ email, plan, expiresAt });
      },
      async createGiftCode({ planId, months, expiresAt, note }) {
        if(!planId) return { ok: false, error: '플랜을 선택하세요.' };
        return adminCreateGiftCode({ planId, months, expiresAt, note });
      },
      async listGiftCodes() {
        return adminListGiftCodes();
      },
      async listUsersWithUsage() {
        return authFetch('/.netlify/functions/list-users-with-usage').catch(err=> ({ ok:false, error: err.message || '사용자 정보를 불러올 수 없습니다.' }));
      },
      async listAnnouncements() {
        return authFetch('/.netlify/functions/list-announcements-admin').catch(err=> ({ ok:false, error: err.message || '공지사항을 불러올 수 없습니다.' }));
      },
      async createAnnouncement(payload) {
        return callAuthed('/.netlify/functions/create-announcement', payload);
      },
      async updateAnnouncement(payload) {
        return callAuthed('/.netlify/functions/update-announcement', payload);
      },
      async deleteAnnouncement(id) {
        return callAuthed('/.netlify/functions/delete-announcement', { id });
      },
      async savePlanCatalog(plans, options={}) {
        return callAuthed('/.netlify/functions/save-plan-catalog', { plans, replaceAll: options.replaceAll === true });
      },
      async updateUserRole({ email, role }) {
        return callAuthed('/.netlify/functions/update-user-role', { email, role });
      },
      async deleteUser(email) {
        return callAuthed('/.netlify/functions/delete-user', { email });
      }
    },
    requestPasswordReset({ email }) {
      return forgotPassword(email);
    },
    async refreshUsage() {
      const value = await refreshUsageInternal();
      Cloud.usage = value;
      return value;
    },
    demoSetSuperadmin(email) {
      if (!email) return { ok: false, error: '이메일 필요' };
      SUPER_ADMINS.add(String(email).toLowerCase());
      return { ok: true };
    },
    demoSetMasterKey(key) {
      return { ok: false, error: '마스터키 변경은 코드에서 직접 수정하세요.' };
    }
  };

  global.Cloud = Cloud;
})(window);
