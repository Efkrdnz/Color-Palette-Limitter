const form = document.querySelector("#palette-form");
const imageInput = document.querySelector("#image-input");
const limitInput = document.querySelector("#palette-limit");
const dropZone = document.querySelector("#drop-zone");
const statusEl = document.querySelector("#status");
const resultsGrid = document.querySelector("#results-grid");
const resultsSummary = document.querySelector("#results-summary");
const downloadButton = document.querySelector("#download-button");
const processButton = document.querySelector("#process-button");
const template = document.querySelector("#result-template");

const MAX_SAMPLE_PIXELS = 60000;
const MAX_OUTPUT_SIDE = 1800;
const MAX_PALETTE_COLORS = 256;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_SIDE = 12000;
const MAX_SOURCE_PIXELS = 60 * 1000 * 1000;
const MAX_BATCH_FILES = 100;
const MAX_ZIP_BYTES = 250 * 1024 * 1024;

let selectedFiles = [];
let processedItems = [];
let isProcessing = false;
let processRunId = 0;

const crcTable = buildCrcTable();

imageInput.addEventListener("change", () => {
  setFiles(Array.from(imageInput.files || []));
});

limitInput.addEventListener("input", () => {
  if (processedItems.length === 0) {
    return;
  }

  clearProcessedResults("Color limit changed. Process images again before downloading.");
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  if (isProcessing) {
    setStatus("Wait for the current processing run to finish before changing files.");
    return;
  }
  setFiles(Array.from(event.dataTransfer.files || []));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isProcessing) {
    return;
  }

  const limit = getValidLimit();

  if (!limit) {
    setStatus(getLimitErrorMessage(), "error");
    limitInput.focus();
    return;
  }

  if (selectedFiles.length === 0) {
    setStatus("Choose at least one image file.", "error");
    return;
  }

  await processFiles(limit);
});

downloadButton.addEventListener("click", async () => {
  if (processedItems.length === 0) {
    return;
  }

  if (processedItems.length === 1) {
    downloadBlob(processedItems[0].blob, processedItems[0].outputName);
    return;
  }

  downloadButton.disabled = true;
  setStatus("Preparing ZIP download...");
  try {
    const zipBlob = await createZip(uniqueEntryNames(processedItems));
    downloadBlob(zipBlob, `palette_exports_lim${processedItems[0].limit}.zip`);
    setStatus(`Downloaded ZIP with ${processedItems.length} PNG files.`, "success");
  } catch (error) {
    setStatus(`Could not create ZIP: ${error.message}`, "error");
  } finally {
    downloadButton.disabled = processedItems.length === 0;
  }
});

function setFiles(files) {
  processRunId += 1;
  clearObjectUrls();
  processedItems = [];
  downloadButton.disabled = true;
  downloadButton.textContent = "Download";

  selectedFiles = files.slice(0, MAX_BATCH_FILES);
  const imageCount = selectedFiles.filter(isImageFile).length;
  const rejectedCount = files.length - imageCount;
  const truncatedCount = Math.max(0, files.length - MAX_BATCH_FILES);

  if (selectedFiles.length === 0) {
    setStatus("No images selected.");
  } else if (truncatedCount > 0) {
    setStatus(`Loaded the first ${MAX_BATCH_FILES} files. ${truncatedCount} extra file${truncatedCount === 1 ? "" : "s"} skipped.`, "error");
  } else if (rejectedCount > 0) {
    setStatus(`${imageCount} image file${imageCount === 1 ? "" : "s"} ready. ${rejectedCount} non-image file${rejectedCount === 1 ? "" : "s"} will be marked as unsupported.`, "error");
  } else {
    setStatus(`${imageCount} image file${imageCount === 1 ? "" : "s"} ready.`);
  }

  renderEmptyState();
}

async function processFiles(limit) {
  isProcessing = true;
  processRunId += 1;
  const runId = processRunId;
  const validFiles = selectedFiles.filter(isImageFile);
  const invalidFiles = selectedFiles.filter((file) => !isImageFile(file));

  clearObjectUrls();
  processedItems = [];
  resultsGrid.replaceChildren();
  downloadButton.disabled = true;
  processButton.disabled = true;
  limitInput.disabled = true;
  imageInput.disabled = true;

  try {
    if (invalidFiles.length > 0) {
      invalidFiles.forEach((file) => renderErrorCard(file, unsupportedFileMessage(file)));
    }

    if (validFiles.length === 0) {
      setStatus("No supported image files to process.", "error");
      updateSummary();
      return;
    }

    setStatus(`Processing 0 of ${validFiles.length}...`);

    for (let index = 0; index < validFiles.length; index += 1) {
      if (runId !== processRunId) {
        return;
      }

      const file = validFiles[index];
      setStatus(`Processing ${index + 1} of ${validFiles.length}: ${file.name}`);

      try {
        const item = await processImage(file, limit);
        processedItems.push(item);
        renderResultCard(item);
      } catch (error) {
        renderErrorCard(file, error.message || "Could not process this image.");
      }

      await nextFrame();
    }

    downloadButton.textContent = processedItems.length > 1 ? "Download ZIP" : "Download PNG";
    downloadButton.disabled = processedItems.length === 0;

    const failures = validFiles.length - processedItems.length + invalidFiles.length;
    if (processedItems.length === 0) {
      setStatus("No images were processed.", "error");
    } else if (failures > 0) {
      setStatus(`Processed ${processedItems.length}; ${failures} file${failures === 1 ? "" : "s"} failed.`, "error");
    } else {
      setStatus(`Processed ${processedItems.length} image${processedItems.length === 1 ? "" : "s"}.`, "success");
    }

    updateSummary();
  } finally {
    if (runId === processRunId) {
      isProcessing = false;
      processButton.disabled = false;
      limitInput.disabled = false;
      imageInput.disabled = false;
    }
  }
}

async function processImage(file, limit) {
  validateImageFileForDecode(file);
  const bitmap = await createImageBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  if (sourceWidth > MAX_SOURCE_SIDE || sourceHeight > MAX_SOURCE_SIDE || sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
    bitmap.close();
    throw new Error(`Image dimensions are too large. Use images up to ${MAX_SOURCE_SIDE}px per side and ${Math.round(MAX_SOURCE_PIXELS / 1000000)}MP.`);
  }

  const { width, height } = fitDimensions(sourceWidth, sourceHeight, MAX_OUTPUT_SIDE);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const imageData = context.getImageData(0, 0, width, height);
  const palette = quantizePalette(imageData.data, width, height, limit);

  if (palette.length === 0) {
    throw new Error("No visible pixels were found in this image.");
  }

  applyPalette(imageData.data, palette);
  context.putImageData(imageData, 0, 0);

  const blob = await canvasToBlob(canvas);
  const previewUrl = URL.createObjectURL(blob);
  const outputName = appendLimitToName(file.name, limit);

  return {
    sourceName: file.name,
    outputName,
    width,
    height,
    sourceWidth,
    sourceHeight,
    limit,
    palette,
    blob,
    previewUrl,
  };
}

function quantizePalette(data, width, height, limit) {
  const step = Math.max(1, Math.ceil((width * height) / MAX_SAMPLE_PIXELS));
  const buckets = new Map();

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += step) {
    const offset = pixelIndex * 4;
    const alpha = data[offset + 3];
    if (alpha < 10) {
      continue;
    }

    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const key = `${r >> 3},${g >> 3},${b >> 3}`;
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }

  let boxes = [Array.from(buckets.values())];

  while (boxes.length < limit) {
    boxes.sort((a, b) => scoreBox(b) - scoreBox(a));
    const box = boxes.shift();

    if (!box || box.length <= 1) {
      if (box) {
        boxes.push(box);
      }
      break;
    }

    const [left, right] = splitBox(box);
    boxes.push(left, right);
  }

  return boxes
    .filter((box) => box.length > 0)
    .map(averageBox)
    .sort((a, b) => luminance(a) - luminance(b));
}

function scoreBox(box) {
  const bounds = getBounds(box);
  const range = Math.max(bounds.maxR - bounds.minR, bounds.maxG - bounds.minG, bounds.maxB - bounds.minB);
  const count = box.reduce((total, color) => total + color.count, 0);
  return range * count;
}

function splitBox(box) {
  const bounds = getBounds(box);
  const ranges = [
    { channel: "r", range: bounds.maxR - bounds.minR },
    { channel: "g", range: bounds.maxG - bounds.minG },
    { channel: "b", range: bounds.maxB - bounds.minB },
  ].sort((a, b) => b.range - a.range);

  const channel = ranges[0].channel;
  const sorted = [...box].sort((a, b) => a[channel] / a.count - b[channel] / b.count);
  const total = sorted.reduce((sum, color) => sum + color.count, 0);
  let running = 0;
  let splitIndex = 1;

  for (let index = 0; index < sorted.length; index += 1) {
    running += sorted[index].count;
    if (running >= total / 2) {
      splitIndex = Math.max(1, index + 1);
      break;
    }
  }

  if (splitIndex >= sorted.length) {
    splitIndex = Math.max(1, Math.floor(sorted.length / 2));
  }

  return [sorted.slice(0, splitIndex), sorted.slice(splitIndex)];
}

function getBounds(box) {
  return box.reduce((bounds, color) => {
    const r = color.r / color.count;
    const g = color.g / color.count;
    const b = color.b / color.count;
    return {
      minR: Math.min(bounds.minR, r),
      maxR: Math.max(bounds.maxR, r),
      minG: Math.min(bounds.minG, g),
      maxG: Math.max(bounds.maxG, g),
      minB: Math.min(bounds.minB, b),
      maxB: Math.max(bounds.maxB, b),
    };
  }, {
    minR: Infinity,
    maxR: -Infinity,
    minG: Infinity,
    maxG: -Infinity,
    minB: Infinity,
    maxB: -Infinity,
  });
}

function averageBox(box) {
  const total = box.reduce((sum, color) => sum + color.count, 0);
  const sums = box.reduce((acc, color) => ({
    r: acc.r + color.r,
    g: acc.g + color.g,
    b: acc.b + color.b,
  }), { r: 0, g: 0, b: 0 });

  return {
    r: Math.round(sums.r / total),
    g: Math.round(sums.g / total),
    b: Math.round(sums.b / total),
  };
}

function applyPalette(data, palette) {
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 10) {
      continue;
    }

    const nearest = findNearestColor(data[offset], data[offset + 1], data[offset + 2], palette);
    data[offset] = nearest.r;
    data[offset + 1] = nearest.g;
    data[offset + 2] = nearest.b;
  }
}

function findNearestColor(r, g, b, palette) {
  let best = palette[0];
  let bestDistance = Infinity;

  for (const color of palette) {
    const distance = ((r - color.r) ** 2) + ((g - color.g) ** 2) + ((b - color.b) ** 2);
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }

  return best;
}

function renderResultCard(item) {
  const node = template.content.firstElementChild.cloneNode(true);
  const image = node.querySelector(".preview-image");
  const fileName = node.querySelector(".file-name");
  const fileMeta = node.querySelector(".file-meta");
  const paletteEl = node.querySelector(".palette");

  image.src = item.previewUrl;
  image.alt = `Processed preview of ${item.sourceName}`;
  fileName.textContent = item.outputName;
  const scaledNote = item.width === item.sourceWidth && item.height === item.sourceHeight
    ? ""
    : `, scaled from ${item.sourceWidth} x ${item.sourceHeight}px`;
  fileMeta.textContent = `${item.width} x ${item.height}px${scaledNote}, ${item.palette.length} color${item.palette.length === 1 ? "" : "s"}`;

  item.palette.forEach((color) => {
    const swatch = document.createElement("div");
    const label = document.createElement("span");
    const hex = rgbToHex(color);
    swatch.className = "swatch";
    swatch.style.backgroundColor = hex;
    label.textContent = hex.toUpperCase();
    swatch.append(label);
    paletteEl.append(swatch);
  });

  resultsGrid.append(node);
}

function renderErrorCard(file, message) {
  const node = template.content.firstElementChild.cloneNode(true);
  const image = node.querySelector(".preview-image");
  const fileName = node.querySelector(".file-name");
  const fileMeta = node.querySelector(".file-meta");
  const paletteEl = node.querySelector(".palette");
  const errorEl = node.querySelector(".result-error");

  image.remove();
  fileName.textContent = file.name;
  fileMeta.textContent = "Not processed";
  paletteEl.remove();
  errorEl.hidden = false;
  errorEl.textContent = message;
  resultsGrid.append(node);
}

function renderEmptyState() {
  resultsGrid.innerHTML = `
    <div class="empty-state">
      <span class="empty-mark" aria-hidden="true"></span>
      <p>Select image files, enter a positive whole number, then process.</p>
    </div>
  `;
  updateSummary();
}

function updateSummary() {
  if (processedItems.length === 0) {
    resultsSummary.textContent = "Processed previews and palettes appear here.";
  } else if (processedItems.length === 1) {
    resultsSummary.textContent = "Single-image output is ready as a direct PNG download.";
  } else {
    resultsSummary.textContent = `${processedItems.length} PNG outputs are ready for ZIP download.`;
  }
}

function getValidLimit() {
  const value = Number(limitInput.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PALETTE_COLORS) {
    return null;
  }
  return value;
}

function isImageFile(file) {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    return false;
  }

  if (file.type.startsWith("image/")) {
    return true;
  }

  if (file.type) {
    return false;
  }

  return /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", tone === "error");
  statusEl.classList.toggle("is-success", tone === "success");
}

function appendLimitToName(fileName, limit) {
  const cleanName = sanitizeFileName(fileName);
  const dotIndex = cleanName.lastIndexOf(".");
  const base = dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
  return `${base}_lim${limit}.png`;
}

function sanitizeFileName(fileName) {
  const rawName = String(fileName || "image").replace(/\\/g, "/").split("/").pop().trim();
  const withoutTraversal = rawName.replace(/\.\.+/g, ".");
  const safeName = withoutTraversal.replace(/[^a-z0-9._ -]+/gi, "-").replace(/\s+/g, " ").trim();
  const stripped = safeName.replace(/^[.\s]+|[.\s]+$/g, "");
  return stripped || "image";
}

function uniqueEntryNames(items) {
  const counts = new Map();

  return items.map((item) => {
    const dotIndex = item.outputName.lastIndexOf(".");
    const base = dotIndex > 0 ? item.outputName.slice(0, dotIndex) : item.outputName;
    const extension = dotIndex > 0 ? item.outputName.slice(dotIndex) : "";
    const seen = counts.get(item.outputName) || 0;
    counts.set(item.outputName, seen + 1);

    return {
      name: seen === 0 ? item.outputName : `${base}_${seen + 1}${extension}`,
      blob: item.blob,
    };
  });
}

function clearProcessedResults(message) {
  clearObjectUrls();
  processedItems = [];
  downloadButton.disabled = true;
  downloadButton.textContent = "Download";
  renderEmptyState();
  setStatus(message);
}

function getLimitErrorMessage() {
  const value = Number(limitInput.value);
  if (Number.isInteger(value) && value > MAX_PALETTE_COLORS) {
    return `Use ${MAX_PALETTE_COLORS} colors or fewer.`;
  }
  return "Enter a positive whole number for the color limit.";
}

function validateImageFileForDecode(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large. Use images up to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`);
  }
}

function unsupportedFileMessage(file) {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    return "SVG files are not supported. Choose PNG, JPEG, WebP, GIF, BMP, or AVIF images.";
  }
  return "Unsupported file type. Choose image files only.";
}

function fitDimensions(width, height, maxSide) {
  const largestSide = Math.max(width, height);
  if (largestSide <= maxSide) {
    return { width, height };
  }

  const scale = maxSide / largestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Canvas export failed."));
      }
    }, "image/png");
  });
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function clearObjectUrls() {
  processedItems.forEach((item) => URL.revokeObjectURL(item.previewUrl));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function luminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const nameBytes = encodeText(entry.name);
    const dataBytes = new Uint8Array(await entry.blob.arrayBuffer());
    totalBytes += dataBytes.length;

    if (totalBytes > MAX_ZIP_BYTES) {
      throw new Error(`ZIP is too large. Keep total output under ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB.`);
    }

    const crc = crc32(dataBytes);
    const localHeader = makeLocalHeader(nameBytes, crc, dataBytes.length);
    localParts.push(localHeader, nameBytes, dataBytes);

    const centralHeader = makeCentralHeader(nameBytes, crc, dataBytes.length, offset);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = makeEndRecord(entries.length, centralSize, offset);
  return new Blob([...localParts, ...centralParts, endRecord], { type: "application/zip" });
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let c = index;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[index] = c >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeLocalHeader(nameBytes, crc, size) {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true);
  return header;
}

function makeCentralHeader(nameBytes, crc, size, offset) {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  return header;
}

function makeEndRecord(entryCount, centralSize, centralOffset) {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

function encodeText(value) {
  return new TextEncoder().encode(value);
}
