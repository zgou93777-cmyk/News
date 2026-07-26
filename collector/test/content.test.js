'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  discoverDocumentLinks,
  discoverJsonFeedUrls,
  discoverStructuredDocumentLinks,
  extractDocument,
  htmlToText
} = require('../src/content');

test('extractDocument reads official metadata and keeps quoted policy text', () => {
  const html = `<!doctype html><html><head>
    <meta name="ArticleTitle" content="国务院关于测试规划的批复">
    <meta name="source" content="国务院">
    <meta name="publishdate" content="2026-07-02">
    <title>不应优先使用的标题</title></head><body>
    <nav>导航内容</nav><h1>国务院关于测试规划的批复</h1>
    <div>发文机关：
国务院办公厅
成文日期：2026年07月02日
发布日期：2026年07月13日</div>
    <div id="UCAP-CONTENT"><div><p>到2030年，测试指标达到60万亿元左右。</p></div><p>本文有删减。</p></div>
    <script>secretNoise()</script></body></html>`;
  const document = extractDocument(html, {
    contentType: 'text/html; charset=utf-8',
    url: 'https://www.gov.cn/example.htm'
  });
  assert.equal(document.title, '国务院关于测试规划的批复');
  assert.equal(document.issuer, '国务院办公厅');
  assert.equal(document.publishedAt, '2026-07-13T00:00:00+08:00');
  assert.match(document.contentText, /60万亿元/);
  assert.doesNotMatch(document.contentText, /secretNoise|导航内容|成文日期/);
});

test('discoverDocumentLinks ranks policy-looking links and resolves relative URLs', () => {
  const html = `
    <a href="/zhengce/content/202607/content_123.htm">国务院关于某规划的批复</a>
    <a href="/about/">关于我们</a>
    <a href="https://news.example.com/zhengce/content_456.htm">外部网站政策通知</a>
    <a href="javascript:void(0)">无效链接</a>`;
  const links = discoverDocumentLinks(html, 'https://www.gov.cn/zhengce/zuixin/');
  assert.deepEqual(links.map((item) => item.url), [
    'https://www.gov.cn/zhengce/content/202607/content_123.htm'
  ]);
});

test('link discovery rejects JS concatenation, source listings, old footer paths and low relevance', () => {
  const source = {
    id: 'gov-news', name: '中国政府网-要闻', institution: '国务院', tier: 'P0',
    url: 'https://www.gov.cn/yaowen/liebiao/'
  };
  const html = `
    <a href="https://www.gov.cn/zhengce/zuixin/'+listArrP[i].URL+'">国务院关于某政策的通知</a>
    <a href="/yaowen/liebiao/">要闻列表</a>
    <a href="/home/2023-01/01/content_1.htm">国务院常务会议</a>
    <a href="/yaowen/liebiao/202607/content_2.htm">国务院常务会议研究部署扩大内需工作</a>
    <a href="/yaowen/liebiao/202606/content_3.htm">中泰、中吉举行例行交流会议</a>`;
  const rejected = [];
  const links = discoverDocumentLinks(html, source.url, 20, {
    source,
    currentYear: 2026,
    onReject: (item) => rejected.push(item)
  });
  assert.deepEqual(links.map((item) => item.url), [
    'https://www.gov.cn/yaowen/liebiao/202607/content_2.htm'
  ]);
  assert.ok(rejected.some((item) => item.reason === 'unsafe_href'));
  assert.ok(rejected.some((item) => item.reason === 'source_listing'));
  assert.ok(rejected.some((item) => item.reason === 'template_or_home_path'));
  assert.ok(rejected.some((item) => item.reason === 'low_relevance'));
});

test('link discovery prioritizes recent-year official policy pages', () => {
  const source = {
    id: 'gov-policy', name: '中国政府网-最新政策', institution: '国务院', tier: 'P0',
    url: 'https://www.gov.cn/zhengce/zuixin/'
  };
  const html = `
    <a href="/zhengce/content/202507/content_1.htm">国务院关于印发甲规划的通知</a>
    <a href="/zhengce/content/202607/content_2.htm">国务院关于印发乙规划的通知</a>
    <a href="/zhengce/content/202307/content_3.htm">国务院关于印发旧规划的通知</a>`;
  const links = discoverDocumentLinks(html, source.url, 20, { source, currentYear: 2026 });
  assert.deepEqual(links.map((item) => item.year), [2026, 2025]);
});

test('structured JSON indexes yield real URLs without evaluating template JavaScript', () => {
  const source = {
    id: 'gov-policy', name: '中国政府网-最新政策', institution: '国务院', tier: 'P0',
    url: 'https://www.gov.cn/zhengce/zuixin/'
  };
  const html = `<script>$.ajax({url: "./ZUIXINZHENGCE.json"});
    html += '<a href="'+listArrP[i].URL+'">'+listArrP[i].TITLE+'</a>';</script>`;
  assert.deepEqual(discoverJsonFeedUrls(html, source.url), [
    'https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json'
  ]);
  const links = discoverStructuredDocumentLinks([
    {
      URL: 'https://www.gov.cn/zhengce/content/202607/content_1.htm',
      TITLE: '国务院关于印发扩大内需规划的通知',
      DOCRELPUBTIME: '2026-07-20'
    },
    {
      URL: 'https://www.gov.cn/zhengce/content/202607/content_2.htm',
      TITLE: '关于表彰先进个人的通知',
      DOCRELPUBTIME: '2026-07-19'
    }
  ], source.url, 20, { source, currentYear: 2026 });
  assert.deepEqual(links.map((item) => item.url), [
    'https://www.gov.cn/zhengce/content/202607/content_1.htm'
  ]);
});

test('htmlToText decodes common and numeric entities', () => {
  assert.equal(htmlToText('<p>A&amp;B &#x4E2D;&#25991;</p>'), 'A&B 中文');
});

test('date-like issuer text falls back to the configured institution', () => {
  const html = `<html><head><title>金融统计数据报告</title></head><body>
    <div>来源：2026年07月20日</div>
    <article>发布时间：2026年07月20日。金融统计数据报告正式发布。</article>
  </body></html>`;
  const document = extractDocument(html, {
    contentType: 'text/html',
    url: 'https://www.pbc.gov.cn/example/index.html',
    source: { institution: '中国人民银行' }
  });
  assert.equal(document.issuer, '中国人民银行');
});
