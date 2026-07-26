'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_IMAGE_BYTES,
  assertSafeRemoteUrl,
  cacheSourceImage,
  extractSourceImageCandidates,
  fetchImageBuffer,
  fetchSourcePage,
  imageDimensions,
  isSameSiteOrSubdomain,
  resolvePublicAddresses
} = require('../src/source-images');

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function png(width = 960, height = 540, size = 16 * 1024) {
  const buffer = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width = 960, height = 540, size = 16 * 1024) {
  const buffer = Buffer.alloc(size);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[size - 2] = 0xff;
  buffer[size - 1] = 0xd9;
  return buffer;
}

function webp(width = 960, height = 540, size = 16 * 1024) {
  const buffer = Buffer.alloc(size);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(size - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  const writeUint24 = (offset, value) => {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
    buffer[offset + 2] = (value >> 16) & 0xff;
  };
  writeUint24(24, width - 1);
  writeUint24(27, height - 1);
  return buffer;
}

function imageResponse(buffer, contentType = 'image/png', init = {}) {
  return new Response(buffer, {
    status: init.status || 200,
    headers: { 'content-type': contentType, ...(init.headers || {}) }
  });
}

test('extracts prioritized source images only from metadata, JSON-LD and article containers', () => {
  const html = `
    <html><head>
      <meta property="og:image" content="/media/hero.jpg">
      <meta name="twitter:image" content="/assets/qrcode.png">
      <script type="application/ld+json">{"image":{"url":"/media/structured.webp"}}</script>
    </head><body>
      <img src="/outside-template.jpg">
      <div id="UCAP-CONTENT">
        <img src="/images/150.jpg">
        <img class="share-logo" src="/assets/share.png">
        <img src="../media/body.png" width="960" height="540">
      </div>
    </body></html>`;
  const candidates = extractSourceImageCandidates(html, 'https://www.gov.cn/zhengce/a.html');
  assert.deepEqual(candidates.map((item) => [item.source, new URL(item.url).pathname]), [
    ['og', '/media/hero.jpg'],
    ['jsonld', '/media/structured.webp'],
    ['body', '/media/body.png']
  ]);
  assert.ok(candidates.every((item) => !item.url.includes('outside-template')));
});

test('cross-site images require official metadata and an explicit allowed image host', () => {
  const pageUrl = 'https://www.gov.cn/zhengce/a.html';
  const html = `
    <meta property="og:image" content="https://img.official-cdn.example/cover.jpg">
    <div id="content"><img src="https://img.official-cdn.example/body.jpg"></div>`;
  assert.deepEqual(extractSourceImageCandidates(html, pageUrl), []);
  const allowed = extractSourceImageCandidates(html, pageUrl, {
    imageHosts: ['img.official-cdn.example']
  });
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].source, 'og');
  assert.equal(isSameSiteOrSubdomain('https://cn/image.jpg', pageUrl), false);
  assert.equal(isSameSiteOrSubdomain('https://static.www.gov.cn/image.jpg', pageUrl), true);
});

test('qualified metadata and JSON-LD stay ahead of article body images', () => {
  const html = `
    <meta property="og:image" content="https://img.official-cdn.example/og.jpg">
    <meta name="twitter:image" content="/media/twitter.jpg">
    <script type="application/ld+json">{"thumbnailUrl":"/media/thumb.jpg"}</script>
    <div id="content"><img src="/media/body.jpg"></div>`;
  const candidates = extractSourceImageCandidates(html, 'https://www.gov.cn/zhengce/a.html', {
    imageHosts: ['img.official-cdn.example']
  });
  assert.deepEqual(candidates.map((item) => item.source), ['og', 'jsonld', 'twitter', 'body']);
});

test('rejects non-HTTPS, credentials, non-443 ports, localhost and private IP literals', () => {
  for (const value of [
    'http://images.example/cover.jpg',
    'https://user:pass@images.example/cover.jpg',
    'https://images.example:8443/cover.jpg',
    'https://localhost/cover.jpg',
    'https://127.0.0.1/cover.jpg',
    'https://[::1]/cover.jpg',
    'https://[::c000:201]/cover.jpg',
    'https://[ff02::1]/cover.jpg',
    'https://[fec0::1]/cover.jpg',
    'https://[2001:db8::1]/cover.jpg',
    'https://169.254.169.254/metadata'
  ]) {
    assert.throws(() => assertSafeRemoteUrl(value));
  }
  assert.equal(assertSafeRemoteUrl('https://images.example/cover.jpg').protocol, 'https:');
});

test('DNS resolution rejects private or mixed answers before a request can be made', async () => {
  await assert.rejects(
    resolvePublicAddresses('images.example', async () => [{ address: '127.0.0.1', family: 4 }]),
    /private, local, or reserved/
  );
  await assert.rejects(
    resolvePublicAddresses('images.example', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 }
    ]),
    /private, local, or reserved/
  );
  for (const address of ['::c000:201', 'ff02::1', 'fec0::1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    await assert.rejects(
      resolvePublicAddresses('images.example', async () => [{ address, family: 6 }]),
      /private, local, or reserved/
    );
  }
  assert.deepEqual(await resolvePublicAddresses('images.example', PUBLIC_LOOKUP), [
    { address: '93.184.216.34', family: 4 }
  ]);
  assert.deepEqual(await resolvePublicAddresses('images.example', async () => [{
    address: '2606:2800:220:1:248:1893:25c8:1946', family: 6
  }]), [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
});

test('revalidates DNS and URL policy on every redirect and sends source headers', async () => {
  const requests = [];
  const lookups = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.images.example/final.png' } });
    }
    return imageResponse(png());
  };
  const result = await fetchImageBuffer('https://images.example/start', {
    pageUrl: 'https://images.example/article',
    fetchImpl,
    lookupImpl: async (hostname) => {
      lookups.push(hostname);
      return PUBLIC_LOOKUP();
    }
  });
  assert.equal(result.extension, 'png');
  assert.deepEqual(lookups, ['images.example', 'cdn.images.example']);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(requests[0].options.headers.Referer, 'https://images.example/article');
  assert.match(requests[0].options.headers['User-Agent'], /^PolicyMonitor\//);

  let call = 0;
  await assert.rejects(fetchImageBuffer('https://images.example/start', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 302, headers: { location: 'https://internal.images.example/final.png' } })
        : imageResponse(png());
    },
    lookupImpl: async (hostname) => hostname.startsWith('internal.')
      ? [{ address: '10.1.2.3', family: 4 }]
      : PUBLIC_LOOKUP()
  }), /private, local, or reserved/);
});

test('source page backfill fetch validates and pins DNS on every manual redirect', async () => {
  const lookups = [];
  let calls = 0;
  const fetched = await fetchSourcePage('https://policy.example/start', {
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://news.policy.example/article' } });
      }
      return new Response('<html>policy</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
    lookupImpl: async (hostname) => {
      lookups.push(hostname);
      return PUBLIC_LOOKUP();
    }
  });
  assert.equal(fetched.body, '<html>policy</html>');
  assert.deepEqual(lookups, ['policy.example', 'news.policy.example']);

  let redirectCalls = 0;
  await assert.rejects(fetchSourcePage('https://policy.example/start', {
    fetchImpl: async () => {
      redirectCalls += 1;
      return redirectCalls === 1
        ? new Response(null, { status: 302, headers: { location: 'https://internal.policy.example/page' } })
        : new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } });
    },
    lookupImpl: async (hostname) => hostname.startsWith('internal.')
      ? [{ address: '127.0.0.1', family: 4 }]
      : PUBLIC_LOOKUP()
  }), /private, local, or reserved/);
});

test('enforces redirect count, streaming size, MIME, magic, file size and dimensions', async () => {
  await assert.rejects(fetchImageBuffer('https://images.example/start', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/again' } }),
    lookupImpl: PUBLIC_LOOKUP
  }), /redirect limit/);

  await assert.rejects(fetchImageBuffer('https://images.example/huge.png', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
    lookupImpl: PUBLIC_LOOKUP
  }), /exceeds/);

  await assert.rejects(fetchImageBuffer('https://images.example/not-image.png', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(Buffer.alloc(16 * 1024), 'text/html'),
    lookupImpl: PUBLIC_LOOKUP
  }), /unsupported image content type/);

  await assert.rejects(fetchImageBuffer('https://images.example/fake.png', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(Buffer.alloc(16 * 1024)),
    lookupImpl: PUBLIC_LOOKUP
  }), /not a supported image/);

  await assert.rejects(fetchImageBuffer('https://images.example/tiny-file.png', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(png(960, 540, 8 * 1024)),
    lookupImpl: PUBLIC_LOOKUP
  }), /too small/);

  await assert.rejects(fetchImageBuffer('https://images.example/tiny-size.png', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(png(320, 180)),
    lookupImpl: PUBLIC_LOOKUP
  }), /dimensions .* too small/);

  await assert.rejects(fetchImageBuffer('https://images.example/decode-bomb.png', {
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(png(10_000, 6_000)),
    lookupImpl: PUBLIC_LOOKUP
  }), /dimensions 10000x6000 exceed safe decoding limits/);
});

test('reads JPEG, PNG and WebP dimensions from headers', () => {
  assert.deepEqual(imageDimensions(jpeg(800, 450), 'jpg'), { width: 800, height: 450 });
  assert.deepEqual(imageDimensions(png(1024, 576), 'png'), { width: 1024, height: 576 });
  assert.deepEqual(imageDimensions(webp(1280, 720), 'webp'), { width: 1280, height: 720 });
});

test('caches identical image content under one stable local URL with an atomic write', async () => {
  const frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cover-'));
  const candidate = {
    url: 'https://images.example/cover.png',
    source: 'og',
    sameSite: true,
    fromMeta: true,
    officialPage: true
  };
  const options = {
    frontendDir,
    pageUrl: 'https://images.example/article',
    fetchImpl: async () => imageResponse(png()),
    lookupImpl: PUBLIC_LOOKUP
  };
  try {
    const first = await cacheSourceImage(candidate, options);
    const second = await cacheSourceImage(candidate, options);
    assert.equal(first.coverImage, second.coverImage);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.match(first.coverImage, /^assets\/covers\/source-[a-f0-9]{64}\.png$/);
    assert.equal(fs.existsSync(path.join(frontendDir, ...first.coverImage.split('/'))), true);
    assert.equal(fs.readdirSync(path.join(frontendDir, 'assets', 'covers')).length, 1);
  } finally {
    fs.rmSync(frontendDir, { recursive: true, force: true });
  }
});
