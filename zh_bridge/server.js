#!/usr/bin/env node
/**
 * AI Toolkit 汉化桥代理（零依赖，仅 Node 核心模块，Win/Linux/macOS 通用）
 *
 * 职责：
 *   - 监听 0.0.0.0:BRIDGE_PORT（默认 8676），反向代理到 127.0.0.1:8675（原版 UI）
 *   - 拦截 text/html 响应，在 </body> 前注入 <script src="/__zh/zh.js" defer>
 *   - /__zh/* 走本地静态服务（zh.js / dict.json），不转发
 *   - WebSocket upgrade（dev HMR）按原始 TCP 透传
 *   - 健康检查自杀：上游曾在线后连续失联 N 次，则自动退出（跨平台统一的进程清理方式）
 *
 * 用法：node server.js   （可用环境变量 ZH_BRIDGE_PORT / ZH_UPSTREAM_PORT 覆盖端口）
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BRIDGE_PORT = parseInt(process.env.ZH_BRIDGE_PORT || '8676', 10);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.ZH_UPSTREAM_PORT || '8675', 10);

// 健康检查参数：每 5 秒探测一次上游；曾在线后连续 6 次失败（30 秒）则退出
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_MAX_FAILS = 6;

// 上游未就绪时对 GET/HEAD 的重试（首次启动可能包含 npm install + build，耗时较长）
const RETRY_DELAY_MS = 250;
const RETRY_MAX = 1200; // 最多约 5 分钟

// 与原版 fileServer 一致：逐跳头不能转发
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function stripHopByHop(headers) {
  const out = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

// ---------------------------------------------------------------------------
// 本地静态服务：/__zh/zh.js、/__zh/dict.json
// ---------------------------------------------------------------------------

const STATIC_FILES = {
  '/__zh/zh.js': { file: path.join(__dirname, 'zh.js'), type: 'application/javascript; charset=utf-8' },
  '/__zh/dict.json': { file: path.join(__dirname, 'dict.json'), type: 'application/json; charset=utf-8' },
};

function serveStatic(req, res, urlPath) {
  const entry = STATIC_FILES[urlPath];
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  fs.readFile(entry.file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('zh-bridge file read error');
      return;
    }
    res.writeHead(200, {
      'content-type': entry.type,
      'cache-control': 'no-store', // 词典可随时更新，不缓存
      'content-length': buf.length,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
  return true;
}

// ---------------------------------------------------------------------------
// HTML 注入
// ---------------------------------------------------------------------------

const INJECT_TAG = '<script src="/__zh/zh.js" defer></script>';

function injectIntoHtml(html) {
  if (html.includes(INJECT_TAG)) return html; // 已注入（防重复）
  let idx = html.lastIndexOf('</body>');
  if (idx === -1) idx = html.lastIndexOf('</head>');
  if (idx === -1) return html + INJECT_TAG;
  return html.slice(0, idx) + INJECT_TAG + html.slice(idx);
}

// ---------------------------------------------------------------------------
// 反向代理
// ---------------------------------------------------------------------------

function proxy(req, res, attempt = 0) {
  const bodyless = req.method === 'GET' || req.method === 'HEAD';
  const headers = stripHopByHop(req.headers);

  // HTML 请求禁用条件请求：注入会改变响应体，304 会让浏览器拿不到注入脚本
  const accept = String(headers.accept || '');
  const wantsHtml = accept.includes('text/html');
  if (wantsHtml) {
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
    // 关键：禁用上游压缩。Next.js 生产模式默认 compress: true，
    // 若透传 accept-encoding，HTML 会以 gzip 返回，注入逻辑将失效。
    delete headers['accept-encoding'];
  }

  const upstreamReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: headers, // Host 头原样透传，Next.js 生成的绝对 URL 才能指向正确端口
    },
    upstreamRes => {
      if (res.destroyed) {
        upstreamRes.resume();
        return;
      }
      const outHeaders = stripHopByHop(upstreamRes.headers);
      const contentType = String(upstreamRes.headers['content-type'] || '');

      if (contentType.includes('text/html') && !upstreamRes.headers['content-encoding']) {
        // 缓冲完整 HTML，注入后一次性发送（页面体积有限，可接受）
        // 兜底：若上游仍返回压缩响应（异常情况），走下方透传分支保持英文页面可用
        const chunks = [];
        upstreamRes.on('data', c => chunks.push(c));
        upstreamRes.on('end', () => {
          if (res.destroyed) return;
          const html = Buffer.concat(chunks).toString('utf8');
          const out = injectIntoHtml(html);
          delete outHeaders['content-length']; // 长度已改变
          delete outHeaders.etag;
          res.writeHead(upstreamRes.statusCode || 502, outHeaders);
          res.end(req.method === 'HEAD' ? undefined : out);
        });
        upstreamRes.on('error', () => res.destroy());
        return;
      }

      // 其他响应（JS/CSS/图片/API 流）直接透传
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    }
  );

  const abortUpstream = () => upstreamReq.destroy();
  res.once('close', abortUpstream);

  upstreamReq.on('error', err => {
    res.removeListener('close', abortUpstream);
    // 上游尚未就绪：无 body 请求可以安全重试（请求体无法重放）
    if (err.code === 'ECONNREFUSED' && bodyless && attempt < RETRY_MAX && !res.destroyed) {
      setTimeout(() => proxy(req, res, attempt + 1), RETRY_DELAY_MS);
      return;
    }
    if (res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">' +
          '<h3>汉化桥：原版 UI 暂不可用</h3>' +
          '<p>上游 http://127.0.0.1:' + UPSTREAM_PORT + ' 无响应。可能仍在构建/启动中，请稍后刷新重试。</p>' +
          '</body>'
      );
    }
  });

  if (bodyless) {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
}

// ---------------------------------------------------------------------------
// 服务器 + WebSocket 透传
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '').split('?')[0];
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (urlPath.startsWith('/__zh/')) {
      serveStatic(req, res, urlPath);
      return;
    }
  }
  proxy(req, res);
});

// dev 模式 HMR 的 WebSocket：按原始 TCP 转发（与原版 fileServer 相同做法）
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

// 上传体积可能很大，与原版一致关闭请求超时
server.requestTimeout = 0;

// ---------------------------------------------------------------------------
// 健康检查自杀：跨平台统一的桥进程生命周期管理
// ---------------------------------------------------------------------------

let upstreamEverOnline = false;
let consecutiveFails = 0;

function healthProbe() {
  const probe = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
  probe.setTimeout(2000);
  probe.on('connect', () => {
    upstreamEverOnline = true;
    consecutiveFails = 0;
    probe.destroy();
  });
  const onFail = () => {
    probe.destroy();
    // 只有"曾经在线后失联"才计数退出；启动阶段（从未在线）不退出，等待原服务构建完成
    if (upstreamEverOnline && ++consecutiveFails >= HEALTH_MAX_FAILS) {
      console.log('[zh-bridge] 原版 UI 已关闭（连续 ' + HEALTH_MAX_FAILS + ' 次探测失败），汉化桥自动退出。');
      process.exit(0);
    }
  };
  probe.on('error', onFail);
  probe.on('timeout', onFail);
}

healthProbe(); // 立即探测一次：上游短暂存活也能被记录为"曾在线"
setInterval(healthProbe, HEALTH_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('[zh-bridge] 端口 ' + BRIDGE_PORT + ' 已被占用。可能上一次的汉化桥仍在运行（它会在原版 UI 关闭后约 30 秒自动退出），或该端口被其他程序占用。');
    console.error('[zh-bridge] 也可设置环境变量 ZH_BRIDGE_PORT 换一个端口。');
    process.exit(1);
  }
  console.error('[zh-bridge] 服务器错误:', err);
  process.exit(1);
});

server.listen(BRIDGE_PORT, () => {
  console.log('[zh-bridge] 汉化桥已启动: http://localhost:' + BRIDGE_PORT + ' -> http://' + UPSTREAM_HOST + ':' + UPSTREAM_PORT);
  console.log('[zh-bridge] 浏览器请访问 http://localhost:' + BRIDGE_PORT + ' 即可看到中文界面。');
});
