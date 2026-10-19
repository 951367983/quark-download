#!/usr/bin/env node
/* 夸克网盘分享 · 免登录下载器（单文件独立版）
 * 由 build-standalone.js 自动生成，请勿直接编辑；改源码请改 server.js / public/index.html。
 * 用法：双击同目录的「启动.bat」，或在本目录执行 node quark-dl.js
 * 依赖：Node.js 18+（无需 npm install）
 */
'use strict';
/**
 * 夸克网盘分享 · 免登录下载器
 * 零第三方依赖，仅使用 Node.js 内置模块（需 Node.js 18+，实测 22 可用）。
 *
 * 原理：调用夸克网盘分享页自身的公开接口，全程不涉及账号登录态。
 *   0) GET  https://pan.quark.cn/s/<pwd_id>            领一张匿名会话 cookie（ctoken）
 *   1) POST /1/clouddrive/share/sharepage/token        取 stoken
 *   2) GET  /1/clouddrive/share/sharepage/detail       列目录
 *   3) POST /1/clouddrive/file/share/download          普通文件直链（有大小上限）
 *   4) GET  /1/clouddrive/share/sharepage/pdf_preview  PDF 原始文件直链（无大小上限）
 *
 * 三个关键点（都是踩出来的坑）：
 *   A. stoken 与 fid_token 是会话绑定的，重新取 stoken 后必须重新列目录拿新的 share_fid_token。
 *   B. CDN 直链与「生成它的那个匿名会话」绑定：换一个 cookie 去下就会 412 Precondition Failed。
 *      因此取链与下载必须共用同一个 cookie jar。
 *   C. 正因为 B，cookie jar 不能全局共享——否则两次解析会互相覆盖会话，导致 412。
 *      所以这里按「解析会话」隔离：每次解析开一个独立 jar，把 sid 返回给前端，
 *      后续取链/下载都带上同一个 sid。多标签页、多人同时用互不干扰。
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URLSearchParams } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
// 本地跑默认只监听 127.0.0.1（不暴露到局域网）；托管平台会注入 PORT，此时自动改绑 0.0.0.0
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
// 可选访问口令：部署到公网时强烈建议设置，否则任何拿到网址的人都能消耗你的流量
// 优先级：环境变量 ACCESS_TOKEN > local.config.json（已 gitignore）
// 注：local.config.json 只在检测到 PORT 环境变量（即部署环境）时读取，本地开发不受影响
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || (process.env.PORT ? readLocalToken() : '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 单文件独立版由 build-standalone.js 把界面注入到这里（本文件保持 null 时走 public 目录）
const EMBEDDED_UI = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>夸克网盘分享 · 免登录下载器</title>\n<style>\n  :root{\n    --bg:#f4f6f9; --card:#ffffff; --line:#e3e7ee; --text:#1b2230; --sub:#65718a;\n    --accent:#2f6fed; --accent-soft:#eaf0ff; --ok:#0f9d58; --ok-soft:#e7f6ee;\n    --warn:#c77700; --warn-soft:#fff5e5; --bad:#d93b3b; --bad-soft:#fdeceb;\n  }\n  *{box-sizing:border-box}\n  body{margin:0;background:var(--bg);color:var(--text);\n       font:14px/1.6 -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif}\n  .wrap{max-width:980px;margin:0 auto;padding:28px 20px 64px}\n  header h1{margin:0 0 6px;font-size:22px;letter-spacing:.3px}\n  header p{margin:0;color:var(--sub);font-size:13px}\n  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:22px 0}\n  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}\n  .card h3{margin:0 0 10px;font-size:13px;color:var(--accent);\n           display:flex;align-items:center;gap:7px;font-weight:600}\n  .card ol{margin:0;padding-left:18px;color:#38435a;font-size:13px}\n  .card ol li{margin:5px 0}\n  .card ul{margin:0;padding-left:0;list-style:none;font-size:13px;color:#38435a}\n  .card ul li{margin:6px 0;display:flex;gap:8px;align-items:flex-start}\n  .dot{width:7px;height:7px;border-radius:50%;margin-top:7px;flex:0 0 auto}\n  .d-ok{background:var(--ok)} .d-warn{background:var(--warn)} .d-bad{background:var(--bad)}\n  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}\n  .row{display:flex;gap:10px;flex-wrap:wrap}\n  input[type=text]{flex:1;min-width:240px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;\n       font-size:13px;outline:none;background:#fbfcfe;color:var(--text);transition:.15s}\n  input[type=text]:focus{border-color:var(--accent);background:#fff;box-shadow:0 0 0 3px var(--accent-soft)}\n  .pwd{flex:0 0 130px;min-width:130px}\n  button{cursor:pointer;border:none;border-radius:8px;padding:10px 18px;font-size:13px;\n         font-weight:600;transition:.15s;font-family:inherit}\n  .btn-primary{background:var(--accent);color:#fff}\n  .btn-primary:hover{background:#2560d8}\n  .btn-primary:disabled{background:#a9bce8;cursor:not-allowed}\n  .btn-sm{padding:6px 13px;font-size:12px;background:var(--accent-soft);color:var(--accent)}\n  .btn-sm:hover{background:#dbe6ff}\n  .btn-sm.ghost{background:#f0f2f6;color:#4a5670}\n  .btn-sm.ghost:hover{background:#e6e9f0}\n  .meta{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;margin:2px 0 14px;font-size:13px;color:var(--sub)}\n  .meta b{color:var(--text);font-size:15px;font-weight:600}\n  table{width:100%;border-collapse:collapse;font-size:13px}\n  th{text-align:left;color:var(--sub);font-weight:500;font-size:12px;padding:8px 10px;\n     border-bottom:1px solid var(--line);white-space:nowrap}\n  td{padding:9px 10px;border-bottom:1px solid #f0f2f6;vertical-align:middle}\n  tr:last-child td{border-bottom:none}\n  tr:hover td{background:#fafbfe}\n  .fname{display:flex;align-items:flex-start;gap:8px;word-break:break-all}\n  .ftype{flex:0 0 auto;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;\n         background:#eef1f6;color:#5b6780;letter-spacing:.4px;margin-top:2px}\n  .ftype.pdf{background:var(--bad-soft);color:var(--bad)}\n  .ftype.vid{background:#eef0ff;color:#4b57d4}\n  .sub{color:var(--sub);font-size:11.5px;margin-top:2px}\n  .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11.5px;font-weight:600;white-space:nowrap}\n  .b-ok{background:var(--ok-soft);color:var(--ok)}\n  .b-warn{background:var(--warn-soft);color:var(--warn)}\n  .b-bad{background:var(--bad-soft);color:var(--bad)}\n  .right{text-align:right;white-space:nowrap}\n  .empty{color:var(--sub);text-align:center;padding:26px 0;font-size:13px}\n  .err{background:var(--bad-soft);color:#8f2323;border:1px solid #f6cfcd;\n       border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px}\n  .hint{color:var(--sub);font-size:12px;margin-top:10px}\n  code{background:#eef1f6;padding:1.5px 5px;border-radius:4px;font-size:12px;\n       font-family:ui-monospace,Consolas,Monaco,monospace}\n  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.45);\n        border-top-color:#fff;border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px;margin-right:6px}\n  @keyframes s{to{transform:rotate(360deg)}}\n  .toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);\n         background:#20293a;color:#fff;padding:11px 20px;border-radius:9px;font-size:13px;\n         opacity:0;pointer-events:none;transition:.25s;z-index:99;max-width:80vw;text-align:center}\n  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}\n  .ld{display:inline-block;width:13px;height:13px;border:2px solid #cfd9ee;border-top-color:var(--accent);\n      border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n\n  <header>\n    <h1>夸克网盘分享 · 免登录下载器</h1>\n    <p>粘贴夸克分享链接即可解析并下载，全程不需要登录夸克账号 · 解析与下载由本服务直连夸克官方接口，不经过任何第三方解析服务</p>\n  </header>\n\n  <div class=\"cards\">\n    <div class=\"card\">\n      <h3>① 使用方法</h3>\n      <ol>\n        <li>复制夸克分享链接，粘贴到下方输入框</li>\n        <li>若分享设有提取码，一并填入</li>\n        <li>点「解析」，列出分享内全部文件</li>\n        <li>点单个「下载」或「全部下载」</li>\n        <li>文件由本机服务中转，保存到浏览器默认下载目录</li>\n      </ol>\n    </div>\n    <div class=\"card\">\n      <h3>② 可下载类型</h3>\n      <ul>\n        <li><span class=\"dot d-ok\"></span><span><b>PDF</b>：任意大小。走预览通道，拿到的是<b>原始文件</b>，实测 62.7 MB 正常</span></li>\n        <li><span class=\"dot d-ok\"></span><span><b>图片 / 文档 / 压缩包等普通文件</b>：单个 ≤ 约 50 MB 可直链下载</span></li>\n        <li><span class=\"dot d-bad\"></span><span><b>大体积视频 / 大压缩包</b>（超过上限）：原文件下载会被服务端拒绝；视频只有转码预览流（画质有损），本工具不提供</span></li>\n      </ul>\n    </div>\n    <div class=\"card\">\n      <h3>③ 文件大小限制</h3>\n      <ul>\n        <li><span class=\"dot d-warn\"></span><span>免登录普通下载：实测 5.8 MB 通过、62.7 MB 被拒，阈值约 <b>50 MB</b>（服务端返回 <code>23018</code>）</span></li>\n        <li><span class=\"dot d-ok\"></span><span>PDF 通道：<b>不受</b>此限制，服务端返回原始文件哈希可供校验</span></li>\n        <li><span class=\"dot d-warn\"></span><span>直链有效期约 3–6 小时，本工具每次下载都会重新取链</span></li>\n      </ul>\n    </div>\n  </div>\n\n  <div class=\"panel\">\n    <div class=\"row\">\n      <input id=\"url\" type=\"text\" placeholder=\"粘贴分享链接，例如 https://pan.quark.cn/s/1a2b3c4d5e6f\" autocomplete=\"off\">\n      <input id=\"pwd\" type=\"text\" class=\"pwd\" placeholder=\"提取码（可选）\" autocomplete=\"off\">\n      <button id=\"go\" class=\"btn-primary\">解析</button>\n    </div>\n    <div class=\"hint\">支持 <code>pan.quark.cn/s/xxxxxx</code> 形式的分享链接；文件层级会自动展开。</div>\n  </div>\n\n  <div id=\"err\" class=\"err\" style=\"display:none\"></div>\n\n  <div id=\"result\" class=\"panel\" style=\"display:none\">\n    <div class=\"meta\">\n      <span>分享：<b id=\"title\"></b></span>\n      <span id=\"author\"></span>\n      <span id=\"count\"></span>\n      <span style=\"margin-left:auto\"><button id=\"all\" class=\"btn-sm\">全部下载</button></span>\n    </div>\n    <table>\n      <thead>\n        <tr><th>文件</th><th class=\"right\">大小</th><th>通道</th><th class=\"right\">操作</th></tr>\n      </thead>\n      <tbody id=\"tbody\"></tbody>\n    </table>\n  </div>\n\n</div>\n<div id=\"toast\" class=\"toast\"></div>\n\n<script>\nconst $ = (s) => document.querySelector(s);\nlet STATE = null;\n\n// 部署到公网且开启了 ACCESS_TOKEN 时，用 ...?k=口令 访问本页；此处把口令透传给所有接口\nconst K = new URLSearchParams(location.search).get('k') || '';\nfunction withK(u){ return K ? u + (u.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K) : u; }\nconst NEED_PWD = '该服务已开启访问口令，请在网址后追加 ?k=你的口令 再访问';\n\nfunction toast(msg){\n  const t = $('#toast'); t.textContent = msg; t.classList.add('show');\n  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);\n}\nfunction fmt(n){\n  if(n === 0) return '0 B';\n  const u = ['B','KB','MB','GB','TB']; let i = 0, v = n;\n  while(v >= 1024 && i < u.length - 1){ v /= 1024; i++; }\n  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];\n}\nfunction typeTag(f){\n  const e = (f.ext || '').toLowerCase();\n  if(e === 'pdf') return '<span class=\"ftype pdf\">PDF</span>';\n  const v = ['mov','mp4','mkv','avi','flv','wmv','m4v','ts'];\n  if(v.includes(e)) return '<span class=\"ftype vid\">VIDEO</span>';\n  return '<span class=\"ftype\">' + (e ? e.toUpperCase().slice(0,4) : 'FILE') + '</span>';\n}\nfunction badge(f){\n  if(f.method === 'blocked') return '<span class=\"badge b-bad\">超出上限</span>';\n  if(f.method === 'pdf')     return '<span class=\"badge b-ok\">PDF 通道</span>';\n  return '<span class=\"badge b-ok\">直链通道</span>';\n}\n\nasync function parse(){\n  const url = $('#url').value.trim();\n  if(!url) return toast('请先粘贴分享链接');\n  $('#err').style.display = 'none';\n  const btn = $('#go');\n  btn.disabled = true; btn.innerHTML = '<span class=\"spin\"></span>解析中';\n  $('#result').style.display = 'none';\n  try{\n    const r = await fetch(withK('/api/parse?url=' + encodeURIComponent(url) + '&pwd=' + encodeURIComponent($('#pwd').value.trim())));\n    if(r.status === 401) throw new Error(NEED_PWD);\n    const d = await r.json();\n    if(!d.ok) throw new Error(d.error || '解析失败');\n    STATE = d;\n    $('#title').textContent = d.title;\n    $('#author').textContent = d.author ? '· ' + d.author : '';\n    $('#count').textContent = '· ' + d.files.length + ' 个文件';\n    const tb = $('#tbody');\n    tb.innerHTML = '';\n    if(!d.files.length){\n      tb.innerHTML = '<tr><td colspan=\"4\" class=\"empty\">该分享内没有可下载的文件</td></tr>';\n    }\n    d.files.forEach((f, i) => {\n      const tr = document.createElement('tr');\n      tr.innerHTML =\n        '<td><div class=\"fname\">' + typeTag(f) +\n          '<div><div>' + f.name + '</div>' +\n          (f.path !== f.name ? '<div class=\"sub\">' + f.path + '</div>' : '') +\n        '</div></div></td>' +\n        '<td class=\"right\">' + fmt(f.size) + '</td>' +\n        '<td>' + badge(f) + '</td>' +\n        '<td class=\"right\"></td>';\n      const cell = tr.lastElementChild;\n      if(f.method !== 'blocked'){\n        const b = document.createElement('button');\n        b.className = 'btn-sm'; b.textContent = '下载';\n        b.onclick = () => startDownload(f, b);\n        cell.appendChild(b);\n        const c = document.createElement('button');\n        c.className = 'btn-sm ghost'; c.textContent = '复制直链'; c.style.marginLeft = '6px';\n        c.onclick = () => copyLink(f, c);\n        cell.appendChild(c);\n      } else {\n        cell.innerHTML = '<button class=\"btn-sm ghost\" disabled>不可用</button>';\n      }\n      tb.appendChild(tr);\n    });\n    $('#result').style.display = '';\n  }catch(e){\n    $('#err').textContent = '解析失败：' + e.message;\n    $('#err').style.display = '';\n  }finally{\n    btn.disabled = false; btn.textContent = '解析';\n  }\n}\n\nfunction dlUrl(f){\n  const q = new URLSearchParams({\n    sid: STATE.sid, pwdId: STATE.pwdId, stoken: STATE.stoken,\n    fid: f.fid, token: f.token, fmt: f.fmt, name: f.name,\n  });\n  return withK('/dl?' + q.toString());\n}\n\nfunction startDownload(f, btn){\n  const old = btn.textContent;\n  btn.disabled = true; btn.innerHTML = '<span class=\"ld\"></span>';\n  const a = document.createElement('a');\n  a.href = dlUrl(f);\n  a.style.display = 'none';\n  document.body.appendChild(a);\n  a.click();\n  setTimeout(() => { a.remove(); btn.disabled = false; btn.textContent = old; }, 2500);\n  toast('已开始下载：' + f.name);\n}\n\nasync function copyLink(f, btn){\n  const old = btn.textContent;\n  btn.disabled = true; btn.textContent = '获取中';\n  try{\n    const r = await fetch(withK('/api/link?' + new URLSearchParams({\n      sid: STATE.sid, pwdId: STATE.pwdId, stoken: STATE.stoken,\n      fid: f.fid, token: f.token, fmt: f.fmt, name: f.name,\n    })));\n    if(r.status === 401) throw new Error(NEED_PWD);\n    const d = await r.json();\n    if(!d.ok) throw new Error(d.error);\n    await navigator.clipboard.writeText(d.url);\n    toast('直链已复制，有效期约 3–6 小时');\n  }catch(e){\n    toast('复制失败：' + e.message);\n  }finally{\n    btn.disabled = false; btn.textContent = old;\n  }\n}\n\n$('#go').onclick = parse;\n$('#url').onkeydown = (e) => { if(e.key === 'Enter') parse(); };\n$('#all').onclick = () => {\n  if(!STATE) return;\n  const list = STATE.files.filter(f => f.method !== 'blocked');\n  if(!list.length) return toast('没有可下载的文件');\n  list.forEach((f, i) => setTimeout(() => {\n    const a = document.createElement('a');\n    a.href = dlUrl(f); a.style.display = 'none';\n    document.body.appendChild(a); a.click(); a.remove();\n  }, i * 1200));\n  toast('已开始下载 ' + list.length + ' 个文件（浏览器可能提示允许多文件下载）');\n};\n\n// 支持 ?url= 预填\nconst pre = new URLSearchParams(location.search).get('url');\nif(pre){ $('#url').value = pre; parse(); }\n</script>\n</body>\n</html>\n";

function readLocalToken() {
  try {
    const f = path.join(__dirname, 'local.config.json');
    if (!fs.existsSync(f)) return '';
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof cfg.accessToken === 'string' ? cfg.accessToken.trim() : '';
  } catch {
    return '';
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const H_API = 'https://drive-pc.quark.cn';
const H_SHARE = 'https://drive-m.quark.cn';
const H_PAN = 'https://pan.quark.cn';

const BASE_HEADERS = {
  'User-Agent': UA,
  'Origin': 'https://pan.quark.cn',
  'Referer': 'https://pan.quark.cn/',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const MAX_DEPTH = 8;
const MAX_NODES = 3000;
const GUEST_LIMIT = 50 * 1024 * 1024;   // 免登录普通下载的实测上限（约 50MB）
const SESSION_TTL = 30 * 60 * 1000;     // 解析会话保留 30 分钟

/* ------------------------------ 匿名会话管理 ------------------------------ */
/* sid -> { jar: Map<name,value>, ts } */

const sessions = new Map();

function createSession() {
  const sid = crypto.randomBytes(12).toString('hex');
  sessions.set(sid, { jar: new Map(), ts: Date.now() });
  return sid;
}

function getSession(sid) {
  const s = sid ? sessions.get(sid) : null;
  if (s) s.ts = Date.now();
  return s || null;
}

function sweepSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.ts > SESSION_TTL) sessions.delete(sid);
}
setInterval(sweepSessions, 5 * 60 * 1000).unref();

function cookieHeader(session) {
  return [...session.jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(session, setCookie) {
  if (!setCookie) return;
  for (const line of [].concat(setCookie)) {
    const kv = String(line).split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) session.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

/** 底层请求，返回未消费的 IncomingMessage（自动带上该会话的 cookie） */
function request(url, { method = 'GET', headers = {}, body = null, timeout = 30000, session = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const h = { ...BASE_HEADERS, ...headers };
    if (session && session.jar.size) h.Cookie = cookieHeader(session);
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: h,
      },
      (res) => { if (session) storeCookies(session, res.headers['set-cookie']); resolve(res); },
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('上游请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

async function readBody(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function jsonRequest(url, opts = {}) {
  const res = await request(url, opts);
  const buf = await readBody(res);
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, message: text.slice(0, 300) || `HTTP ${res.statusCode}` };
  }
}

/** 访问分享页，给该会话领取匿名 cookie */
async function seedSession(session, pwdId) {
  const res = await request(`${H_PAN}/s/${pwdId}`, { session });
  await readBody(res);
  return res.statusCode;
}

/* -------------------------------- 夸克接口 --------------------------------- */

function qs(obj) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) sp.set(k, String(v));
  return sp.toString();
}

async function getShareToken(session, pwdId, passcode) {
  const seed = await seedSession(session, pwdId);
  const d = await jsonRequest(`${H_API}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=`, {
    method: 'POST',
    session,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pwd_id: pwdId, passcode: passcode || '' }),
  });
  if (d.code !== 0) {
    throw new Error(`${d.message || `code=${d.code}`}（分享页 HTTP ${seed}）`);
  }
  return d.data;
}

async function listDir(session, pwdId, stoken, pdirFid) {
  const d = await jsonRequest(`${H_SHARE}/1/clouddrive/share/sharepage/detail?` + qs({
    pr: 'ucpro', fr: 'pc', pwd_id: pwdId, stoken,
    pdir_fid: pdirFid, force: 0, _page: 1, _size: 200,
    _sort: 'file_type:asc,updated_at:desc', uc_param_str: '',
  }), { session });
  if (d.code !== 0) throw new Error(d.message || `code=${d.code}`);
  return d.data.list || [];
}

/** pdir_fid=0 返回的若是单个文件夹，需再进入该文件夹才是真正的分享根 */
async function listRoot(session, pwdId, stoken) {
  let items = await listDir(session, pwdId, stoken, 0);
  if (items.length === 1 && items[0].dir) {
    const inner = await listDir(session, pwdId, stoken, items[0].fid);
    if (inner.length) items = inner;
  }
  return items;
}

async function walkAll(session, pwdId, stoken) {
  const out = [];
  let nodes = 0;

  async function walk(fid, prefix, depth) {
    if (depth > MAX_DEPTH || nodes > MAX_NODES) return;
    const items = await listDir(session, pwdId, stoken, fid);
    for (const it of items) {
      if (++nodes > MAX_NODES) return;
      const p = prefix ? `${prefix}/${it.file_name}` : it.file_name;
      if (it.dir) {
        await walk(it.fid, p, depth + 1);
      } else {
        out.push({
          name: it.file_name, path: p, fid: it.fid, token: it.share_fid_token,
          size: it.size, fmt: it.format_type || '',
          ext: (String(it.file_name).split('.').pop() || '').toLowerCase(),
        });
      }
    }
  }

  await walk('0', '', 0);
  return out;
}

function classify(f) {
  if (f.fmt === 'application/pdf' || f.ext === 'pdf') return { method: 'pdf', label: 'PDF 通道' };
  if (f.size > GUEST_LIMIT) return { method: 'blocked', label: '超限' };
  return { method: 'guest', label: '直链通道' };
}

/** 取可用的下载直链；优先普通通道，失败再走 PDF 预览通道 */
async function resolveLink(session, pwdId, stoken, file) {
  const isPdf = file.fmt === 'application/pdf' || /\.pdf$/i.test(file.name || '');

  const g = await jsonRequest(`${H_SHARE}/1/clouddrive/file/share/download?pr=ucpro&fr=pc&uc_param_str=`, {
    method: 'POST',
    session,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fids: [file.fid], pwd_id: pwdId, stoken, fids_token: [file.token] }),
  });
  if (g.code === 0 && g.data && g.data[0] && g.data[0].download_url) {
    return { url: g.data[0].download_url, method: 'guest', size: g.data[0].size, name: g.data[0].file_name };
  }

  if (isPdf) {
    const p = await jsonRequest(`${H_SHARE}/1/clouddrive/share/sharepage/pdf_preview?` + qs({
      pr: 'ucpro', fr: 'pc', pwd_id: pwdId, stoken, fid: file.fid, fid_token: file.token,
    }), { session });
    if (p.code === 0 && p.data && p.data.download_url) {
      return { url: p.data.download_url, method: 'pdf', size: p.data.size, name: file.name, sha1: p.data.sha1 };
    }
    throw new Error(`PDF 预览通道失败：${p.message || p.code}`);
  }

  if (g.code === 23018) {
    throw new Error('免登录下载有单文件大小上限（约 50MB），该文件超出限制。请登录夸克账号后转存到自己的网盘再下载。');
  }
  throw new Error(`获取直链失败：${g.message || g.code}`);
}

/** 拉取上游文件流，遇到 412（会话不匹配/过期）重播一次会话再试 */
async function openStream(session, link, range, pwdId) {
  let up = await request(link.url, { headers: range ? { Range: range } : {}, timeout: 20000, session });
  if (up.statusCode === 412 && pwdId) {
    await readBody(up).catch(() => {});
    await seedSession(session, pwdId);
    up = await request(link.url, { headers: range ? { Range: range } : {}, timeout: 20000, session });
  }
  return up;
}

/* --------------------------------- HTTP ---------------------------------- */

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, file) {
  if (EMBEDDED_UI && file === 'index.html') {
    const data = Buffer.from(EMBEDDED_UI, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length });
    return res.end(data);
  }
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const data = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}

function parseShare(link) {
  if (!link) return null;
  const m = link.match(/\/s\/([0-9a-zA-Z]+)/) || link.match(/^([0-9a-zA-Z]{6,})$/);
  return m ? m[1] : null;
}

/** 读请求里的口令：?k= > x-access-token 头 > cookie（由首次带 ?k= 的访问种下） */
function givenToken(req, u) {
  const q = u.searchParams.get('k');
  if (q) return q;
  const h = req.headers['x-access-token'];
  if (h) return h;
  const m = /(?:^|;\s*)quark_k=([^;]*)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function tokenOk(req, u) {
  if (!ACCESS_TOKEN) return true;
  return givenToken(req, u) === ACCESS_TOKEN;
}

function sendGuard(res, badToken) {
  const body = Buffer.from(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>需要访问口令 · 夸克分享下载器</title>'
    + "<body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;"
    + 'max-width:560px;margin:12vh auto;padding:0 24px;line-height:1.8;color:#1b2230">'
    + '<h2 style="margin:0 0 8px">需要访问口令</h2>'
    + (badToken ? '<p style="color:#c0392b;margin:0 0 12px">口令不正确，请重新输入。</p>' : '')
    + '<p style="color:#65718a;margin:0 0 18px">这是一个私有实例，请输入访问口令后进入。'
    + '输入一次后浏览器会记住 30 天，之后直接打开带口令的网址或本页即可。</p>'
    + '<form method="get" action="/" style="display:flex;gap:8px;flex-wrap:wrap">'
    + '<input name="k" autocomplete="off" autofocus placeholder="访问口令" '
    + 'style="flex:1;min-width:200px;padding:11px 13px;border:1px solid #d8dde7;border-radius:9px;font-size:15px">'
    + '<button type="submit" style="padding:11px 22px;border:0;border-radius:9px;background:#2f6fed;color:#fff;'
    + 'font-size:15px;cursor:pointer">进入</button></form>'
    + '<p style="color:#8b95a8;font-size:13px;margin-top:22px">'
    + '也可以直接在网址后追加 <code>?k=你的口令</code> 访问，例如：<br>'
    + '<code>https://你的域名/?k=你的口令</code></p></body>',
    'utf8',
  );
  if (res.headersSent) return res.end();
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = u.pathname;

  try {
    if (!tokenOk(req, u)) return sendGuard(res, !!u.searchParams.get('k'));

    // 带 ?k= 首次访问成功后种一枚 cookie，
    // 这样预览面板/浏览器后续丢掉查询串的请求（图标、子路径、刷新）仍然可用
    if (ACCESS_TOKEN && u.searchParams.get('k') === ACCESS_TOKEN) {
      res.setHeader('Set-Cookie',
        `quark_k=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`);
    }

    if (p === '/favicon.ico' || p === '/robots.txt') { res.writeHead(204); return res.end(); }

    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');

    if (p === '/api/health') {
      return sendJson(res, { ok: true, sessions: sessions.size, guard: !!ACCESS_TOKEN });
    }

    if (p === '/api/parse') {
      const pwdId = parseShare((u.searchParams.get('url') || '').trim());
      if (!pwdId) {
        return sendJson(res, { ok: false, error: '无法识别分享 ID。请粘贴完整分享链接，形如 https://pan.quark.cn/s/xxxxxx' }, 400);
      }
      const passcode = (u.searchParams.get('pwd') || '').trim();

      // 每次解析开一个独立会话，避免并发/多标签页互相覆盖 cookie 导致 412
      const sid = createSession();
      const session = getSession(sid);

      const info = await getShareToken(session, pwdId, passcode);
      const files = await walkAll(session, pwdId, info.stoken);

      return sendJson(res, {
        ok: true,
        sid,
        pwdId,
        stoken: info.stoken,
        title: info.title || '未命名分享',
        author: (info.author && info.author.nick_name) || '',
        files: files.map((f) => {
          const c = classify(f);
          return {
            name: f.name, path: f.path, size: f.size, fid: f.fid, token: f.token,
            fmt: f.fmt, ext: f.ext, method: c.method, label: c.label,
          };
        }),
      });
    }

    // 以下三个接口都需要带上 /api/parse 返回的 sid
    const needSession = () => {
      const s = getSession(u.searchParams.get('sid'));
      if (!s) throw new Error('解析会话已过期（保留 30 分钟），请重新点「解析」。');
      return s;
    };

    if (p === '/api/link') {
      const session = needSession();
      const r = await resolveLink(session, u.searchParams.get('pwdId'), u.searchParams.get('stoken'), {
        fid: u.searchParams.get('fid'), token: u.searchParams.get('token'),
        name: u.searchParams.get('name') || 'file', fmt: u.searchParams.get('fmt') || '',
      });
      return sendJson(res, { ok: true, url: r.url, method: r.method, size: r.size, sha1: r.sha1 || null });
    }

    if (p === '/dl') {
      const session = needSession();
      const pwdId = u.searchParams.get('pwdId');
      const name = u.searchParams.get('name') || 'download';
      const link = await resolveLink(session, pwdId, u.searchParams.get('stoken'), {
        fid: u.searchParams.get('fid'), token: u.searchParams.get('token'),
        name, fmt: u.searchParams.get('fmt') || '',
      });

      const up = await openStream(session, link, req.headers.range, pwdId);
      if (up.statusCode !== 200 && up.statusCode !== 206) {
        await readBody(up).catch(() => {});
        throw new Error(`上游 CDN 返回 ${up.statusCode}（可能链接已过期，请重试）`);
      }

      const head = {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (up.headers['content-length']) head['Content-Length'] = up.headers['content-length'];
      if (up.headers['content-range']) head['Content-Range'] = up.headers['content-range'];

      res.writeHead(up.statusCode, head);
      up.pipe(res);
      // 上游出错时安全收尾，避免进程崩溃
      up.on('error', () => { try { res.destroy(); } catch (_) {} });
      res.on('close', () => { try { up.destroy(); } catch (_) {} });
      return;
    }

    // 兜底：非接口路径一律回落首页。
    // 预览面板有可能用子路径打开本应用，若直接 404 会显示 "404 Not Found"，看起来就像「链接失效」。
    if (!p.startsWith('/api/') && !p.startsWith('/dl')) return serveStatic(res, 'index.html');

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: `未知接口 ${p}` }));
  } catch (err) {
    try {
      if (p === '/dl' && res.headersSent) res.end();
      else sendJson(res, { ok: false, error: String((err && err.message) || err) }, 500);
    } catch (_) { /* ignore */ }
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  console.log('');
  console.log('  夸克网盘分享 · 免登录下载器已启动');
  console.log(`  监听：   http://${shown}:${PORT}`);
  if (HOST === '0.0.0.0') console.log(`  局域网： http://<本机IP>:${PORT}`);
  const src = process.env.ACCESS_TOKEN ? '环境变量' : 'local.config.json';
  console.log(`  访问口令：${ACCESS_TOKEN ? `已开启（来自 ${src}，网址后加 ?k=口令）` : '未开启'}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');

  // 本地双击启动时自动打开浏览器；部署环境（有 PORT 变量）或设了 NO_OPEN=1 时不弹
  if (!process.env.PORT && process.env.NO_OPEN !== '1') {
    const url = `http://127.0.0.1:${PORT}`;
    try {
      if (process.platform === 'win32') require('node:child_process').exec(`start "" "${url}"`);
      else if (process.platform === 'darwin') require('node:child_process').exec(`open "${url}"`);
    } catch (_) { /* 打不开就算了，用户自己点链接 */ }
  }
});

process.on('uncaughtException', (e) => console.error('[未捕获异常]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[未处理拒绝]', e && (e.message || e)));
