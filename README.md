# Auditfy Deployment Guide

Auditfy is a static front-end bundled with Netlify Functions that handle Supabase auth and Cloudflare R2 storage. This guide explains how to set up the required services and deploy the project to Netlify.

## 1. Prerequisites
- Netlify account with CLI (`npm install -g netlify-cli`).
- Supabase project for authentication and metadata.
- Cloudflare R2 bucket for file storage.
- (Optional) Gmail account or SMTP service for password-reset emails.

## 2. Environment Variables
Create a `.env` file at the project root (or configure the same keys in Netlify Site settings → Environment variables). The serverless functions automatically load it via `netlify/functions/_shared/loadEnv.js`.

| Key | Description |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (keep secret). |
| `R2_ACCOUNT_ID` | Cloudflare R2 account ID. |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 access key. |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret access key. |
| `R2_BUCKET_CLOUD` | Bucket name storing the user cloud files. |
| `R2_BUCKET_PROJECTS` | Bucket name storing project uploads. |
| `MAIL_USER` | Sender email account (for password reset). |
| `MAIL_PASS` | Sender email password or app password. |
| `MAIL_FROM` | Displayed “from” email address. |

> For production, add the same variables in Netlify so the functions can access them. Do **not** commit the `.env` file.

## 3. Front-End Supabase Configuration
`cloud.js` defaults to placeholder Supabase settings. Either:
1. Replace `DEFAULT_CONFIG` with your project URL and anon key, or
2. Inject runtime values by setting `window.__AUDITFY_SUPABASE__` before loading `cloud.js`.

Ensure the HTML files include the Supabase JS SDK (e.g. `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js"></script>`).

## 4. Installing Dependencies
The Netlify Functions have their own dependencies:
```bash
npm install --prefix netlify/functions
```

## 5. Local Development
1. Populate `.env` (see section 2).
2. Install the Netlify CLI (`npm install -g netlify-cli`).
3. Run `netlify dev` from the project root. This serves static files and proxies Functions so you can sign in and exercise cloud features locally.

## 6. Deploying to Netlify
### Option A: Git-based Deploy
1. Push the repository to a Git provider (GitHub, GitLab, Bitbucket).
2. Netlify dashboard → **Add new site** → **Import from Git**.
3. Set **Build command** empty, **Publish directory** to `.`. Functions path is detected via `netlify.toml`.
4. Add the environment variables in Site settings and trigger a deploy.

### Option B: Netlify CLI
```bash
netlify login
netlify init      # select or create a site, confirm publish directory "."
netlify deploy --prod
```

## 7. After Deploy
- Verify Supabase Row Level Security rules to ensure data isolation.
- In Cloudflare R2, enable CORS rules that allow Netlify origins.
- Test file upload/download flows using an authenticated user to confirm tokens and signed URLs work end-to-end.
