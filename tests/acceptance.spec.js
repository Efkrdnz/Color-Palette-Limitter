const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const fixtureDir = path.join(__dirname, 'fixtures');

function writeBmp(filePath, width, height, pixels) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const buffer = Buffer.alloc(fileSize);

  buffer.write('BM', 0);
  buffer.writeUInt32LE(fileSize, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelDataSize, 34);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = pixels[(height - 1 - y) * width + x];
      const offset = 54 + y * rowSize + x * 3;
      buffer[offset] = source[2];
      buffer[offset + 1] = source[1];
      buffer[offset + 2] = source[0];
    }
  }

  fs.writeFileSync(filePath, buffer);
}

function makeFixturePixels(seed) {
  return Array.from({ length: 16 }, (_, index) => [
    (seed + index * 41) % 256,
    (seed * 2 + index * 67) % 256,
    (seed * 3 + index * 97) % 256
  ]);
}

test.beforeAll(() => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  writeBmp(path.join(fixtureDir, 'many-colors.bmp'), 4, 4, makeFixturePixels(13));
  writeBmp(path.join(fixtureDir, 'blocks-a.bmp'), 4, 4, makeFixturePixels(29));
  writeBmp(path.join(fixtureDir, 'blocks-b.bmp'), 4, 4, makeFixturePixels(73));
  fs.writeFileSync(path.join(fixtureDir, 'not-an-image.txt'), 'This is intentionally not an image.');
});

async function fileInput(page) {
  const input = page.locator('input[type="file"]').first();
  await expect(input, 'the app must expose a file input').toBeAttached();
  await expect(input, 'the file input should accept multiple images').toHaveAttribute('multiple', /./);
  await expect(input, 'the file input should communicate image-only uploads').toHaveAttribute('accept', /image/i);
  return input;
}

async function limitInput(page) {
  const labelled = page.getByLabel(/(palette\s*)?limit|max(imum)?\s*colors|number/i).first();
  if (await labelled.count()) return labelled;

  const numeric = page.locator('input[type="number"]').first();
  await expect(numeric, 'the app must expose a numeric palette limit input').toBeAttached();
  return numeric;
}

async function setLimit(page, value) {
  const input = await limitInput(page);
  await input.fill('');
  await input.fill(value).catch(async () => {
    await input.evaluate((element, nextValue) => {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  });
}

async function processImages(page) {
  const explicitProcessButton = page
    .getByRole('button', { name: /process|extract|generate|reduce|convert|create/i })
    .first();

  if (await explicitProcessButton.count()) {
    await explicitProcessButton.click();
  }
}

async function downloadControl(page, zipOnly = false) {
  const zipPattern = /zip|download\s+all|bulk/i;
  const downloadPattern = /download/i;
  const rolePattern = zipOnly ? zipPattern : downloadPattern;

  const roleButton = page.getByRole('button', { name: rolePattern }).first();
  if (await roleButton.count()) return roleButton;

  const roleLink = page.getByRole('link', { name: rolePattern }).first();
  if (await roleLink.count()) return roleLink;

  const selector = zipOnly
    ? 'a[download*=".zip" i], a[download*="zip" i], button:has-text("ZIP"), a:has-text("ZIP")'
    : 'a[download], button:has-text("Download"), a:has-text("Download")';
  return page.locator(selector).first();
}

async function enabledDownloadCount(page) {
  return page.locator('a[download], button, a').evaluateAll(elements =>
    elements.filter(element => {
      const text = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('download') || ''}`;
      const style = window.getComputedStyle(element);
      return /download/i.test(text) &&
        !element.disabled &&
        element.getAttribute('aria-disabled') !== 'true' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden';
    }).length
  );
}

async function visibleSwatchCount(page) {
  return page.evaluate(() => {
    const colorCounts = new Map();
    for (const element of document.querySelectorAll('body *')) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const background = style.backgroundColor;
      if (
        rect.width >= 8 &&
        rect.width <= 96 &&
        rect.height >= 8 &&
        rect.height <= 96 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        background &&
        !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/i.test(background)
      ) {
        colorCounts.set(background, (colorCounts.get(background) || 0) + 1);
      }
    }
    return colorCounts.size;
  });
}

async function uniqueDownloadedImageColors(page, downloadPath) {
  const extension = path.extname(downloadPath).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png';
  const dataUrl = `data:image/${extension};base64,${fs.readFileSync(downloadPath).toString('base64')}`;

  return page.evaluate(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 0) {
        colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
      }
    }
    return colors.size;
  }, dataUrl);
}

function zipEntryNames(zipPath) {
  const data = fs.readFileSync(zipPath);
  const names = [];
  let offset = 0;
  while (offset < data.length - 46) {
    if (data.readUInt32LE(offset) === 0x02014b50) {
      const nameLength = data.readUInt16LE(offset + 28);
      const extraLength = data.readUInt16LE(offset + 30);
      const commentLength = data.readUInt16LE(offset + 32);
      names.push(data.slice(offset + 46, offset + 46 + nameLength).toString('utf8'));
      offset += 46 + nameLength + extraLength + commentLength;
    } else {
      offset += 1;
    }
  }
  return names;
}

test('single image: applies a positive integer palette limit, previews output, and downloads a lim{number} file', async ({ page }) => {
  await page.goto('/');
  await (await fileInput(page)).setInputFiles(path.join(fixtureDir, 'many-colors.bmp'));
  await setLimit(page, '5');
  await processImages(page);

  await expect(page.locator('canvas, img').first(), 'processed image preview should be visible').toBeVisible();
  await expect.poll(() => visibleSwatchCount(page), {
    message: 'palette swatches should be rendered after processing'
  }).toBeGreaterThanOrEqual(2);

  const control = await downloadControl(page);
  await expect(control, 'single processed image should have a download control').toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await control.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^many-colors_lim5\.[a-z0-9]+$/i);

  const downloadPath = await download.path();
  expect(await uniqueDownloadedImageColors(page, downloadPath)).toBeLessThanOrEqual(5);
});

test('bulk upload: offers a zip whose entries append lim{number} to each processed image name', async ({ page }) => {
  await page.goto('/');
  await (await fileInput(page)).setInputFiles([
    path.join(fixtureDir, 'blocks-a.bmp'),
    path.join(fixtureDir, 'blocks-b.bmp')
  ]);
  await setLimit(page, '8');
  await processImages(page);

  const control = await downloadControl(page, true);
  await expect(control, 'bulk mode should expose a ZIP or download-all control').toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await control.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/i);

  const entries = zipEntryNames(await download.path());
  expect(entries).toEqual(expect.arrayContaining([
    expect.stringMatching(/^blocks-a_lim8\.[a-z0-9]+$/i),
    expect.stringMatching(/^blocks-b_lim8\.[a-z0-9]+$/i)
  ]));
});

test('invalid palette limits are rejected before downloads are enabled', async ({ page }) => {
  for (const invalidLimit of ['', '0', '-3', '2.5', 'abc', '257']) {
    await test.step(`rejects "${invalidLimit || 'empty'}"`, async () => {
      await page.goto('/');
      await (await fileInput(page)).setInputFiles(path.join(fixtureDir, 'many-colors.bmp'));
      await setLimit(page, invalidLimit);
      await processImages(page);

      const input = await limitInput(page);
      const browserInvalid = await input.evaluate(element =>
        typeof element.checkValidity === 'function' ? !element.checkValidity() : false
      );
      const validationMessageCount = await page.getByText(/positive|integer|valid|limit|number|required/i).count();

      expect(browserInvalid || validationMessageCount > 0).toBeTruthy();
      await expect.poll(() => enabledDownloadCount(page), {
        message: `download controls must stay disabled for invalid limit "${invalidLimit}"`
      }).toBe(0);
    });
  }
});

test('changing the color limit after processing clears stale downloads', async ({ page }) => {
  await page.goto('/');
  await (await fileInput(page)).setInputFiles(path.join(fixtureDir, 'many-colors.bmp'));
  await setLimit(page, '8');
  await processImages(page);

  await expect.poll(() => enabledDownloadCount(page), {
    message: 'download should become available after successful processing'
  }).toBeGreaterThan(0);

  await setLimit(page, '5');

  await expect(page.getByText(/process images again|limit changed/i).first()).toBeVisible();
  await expect.poll(() => enabledDownloadCount(page), {
    message: 'download must be cleared after the limit changes'
  }).toBe(0);

  await processImages(page);
  const control = await downloadControl(page);
  const downloadPromise = page.waitForEvent('download');
  await control.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^many-colors_lim5\.[a-z0-9]+$/i);
});

test('rapid repeated processing clicks do not duplicate the same output', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const realCreateImageBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = (...args) => new Promise((resolve, reject) => {
      setTimeout(() => realCreateImageBitmap(...args).then(resolve, reject), 120);
    });
  });

  await (await fileInput(page)).setInputFiles(path.join(fixtureDir, 'many-colors.bmp'));
  await setLimit(page, '4');

  const processButton = page.getByRole('button', { name: /process|extract|generate|reduce|convert|create/i }).first();
  await processButton.click();
  await expect(processButton).toBeDisabled();
  await page.evaluate(() => document.querySelector('button[type="submit"]').click());

  await expect(page.getByRole('button', { name: /download/i }).first()).toBeEnabled();
  await expect(page.locator('.result-card')).toHaveCount(1);
});

test('bulk zip keeps same-basename image entries unique and path-safe', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    async function makeImageFile(name, color) {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 2, 2);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    }

    const transfer = new DataTransfer();
    transfer.items.add(await makeImageFile('../same.jpg', '#d14b31'));
    transfer.items.add(await makeImageFile('same.png', '#296b58'));

    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await setLimit(page, '3');
  await processImages(page);

  const control = await downloadControl(page, true);
  const downloadPromise = page.waitForEvent('download');
  await control.click();
  const download = await downloadPromise;
  const entries = zipEntryNames(await download.path());

  expect(entries).toEqual(expect.arrayContaining(['same_lim3.png', 'same_lim3_2.png']));
  expect(entries.every(name => !name.includes('/') && !name.includes('\\') && !name.includes('..'))).toBeTruthy();
});

test('non-image uploads are rejected or marked with an error and cannot be downloaded', async ({ page }) => {
  await page.goto('/');
  await (await fileInput(page)).setInputFiles(path.join(fixtureDir, 'not-an-image.txt'));
  await setLimit(page, '4');
  await processImages(page);

  await expect(page.getByText(/unsupported|invalid|not an image|image file|corrupt|failed|error/i).first()).toBeVisible();
  await expect.poll(() => enabledDownloadCount(page), {
    message: 'non-image input must not produce an enabled download'
  }).toBe(0);
});

test('mobile viewport keeps the upload and limit workflow usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(await fileInput(page)).toBeVisible();
  await expect(await limitInput(page)).toBeVisible();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(392);
});
