/**
 * AI Toolkit 客户端汉化脚本（由汉化桥代理注入，运行在浏览器中，平台无关）
 *
 * 工作方式：
 *   - 拉取 /__zh/dict.json 词典（精确匹配表 + 正则模板）
 *   - 遍历 DOM 文本节点做词典替换（大小写不敏感查表，保留首尾空白）
 *   - 翻译 placeholder / title / aria-label / alt 属性
 *   - MutationObserver 监听 React 重渲染/路由切换，防抖后增量再翻译
 *
 * 防死循环：替换结果为中文，词典键均为英文，二次查表不命中即收敛；
 * React 把文本改回英文时 observer 会再次翻译回来。
 */
(function () {
  'use strict';
  if (window.__ZH_BRIDGE__) return;
  window.__ZH_BRIDGE__ = true;

  // 跳过这些标签内的文本（代码/脚本/用户输入）
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var TR_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  var MAP = Object.create(null); // 小写英文 -> 中文
  var PATTERNS = []; // { re: RegExp, to: String }

  function applyDict(data) {
    var map = (data && data.map) || {};
    for (var k in map) MAP[k.toLowerCase()] = map[k];
    var pats = (data && data.patterns) || [];
    for (var i = 0; i < pats.length; i++) {
      var p = pats[i]; // [regexSource, flags, replacement]
      if (p && p.length >= 2) {
        PATTERNS.push({
          re: new RegExp(p[0], p[1] || ''),
          to: p.length >= 3 ? p[2] : '',
        });
      }
    }
  }

  // 翻译一段文本；未命中返回原值
  function translateText(raw) {
    if (!raw) return raw;
    var key = raw.trim();
    if (!key) return raw;
    var hit = MAP[key.toLowerCase()];
    if (hit !== undefined && hit !== null) {
      // 保留首尾空白
      var m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
      return m[1] + hit + m[3];
    }
    for (var i = 0; i < PATTERNS.length; i++) {
      var p = PATTERNS[i];
      if (p.re.test(raw)) return raw.replace(p.re, p.to);
    }
    return raw;
  }

  function translateTextNode(node) {
    var t = translateText(node.nodeValue);
    if (t !== node.nodeValue) node.nodeValue = t;
  }

  function translateAttrs(el) {
    if (!el.getAttribute) return;
    for (var i = 0; i < TR_ATTRS.length; i++) {
      var a = TR_ATTRS[i];
      var v = el.getAttribute && el.getAttribute(a);
      if (v) {
        var t = translateText(v);
        if (t !== v) el.setAttribute(a, t);
      }
    }
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3 /* TEXT_NODE */) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== 1 /* ELEMENT_NODE */ && root.nodeType !== 9 /* DOCUMENT_NODE */ && root.nodeType !== 11 /* FRAGMENT */) return;
    translateAttrs(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) translateTextNode(walker.currentNode);
  }

  // MutationObserver：防抖 + 只在仍有可翻译内容时扫描
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      translateTree(document.body || document.documentElement);
    }, 50);
  }

  function start() {
    translateTree(document.documentElement);
    var mo = new MutationObserver(function () {
      schedule();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  fetch('/__zh/dict.json')
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      applyDict(d);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
      } else {
        start();
      }
    })
    .catch(function (e) {
      console.warn('[zh-bridge] 词典加载失败，界面保持英文:', e);
    });
})();
