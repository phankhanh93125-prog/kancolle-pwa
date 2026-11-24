/**
 * Mobile Local Asset Compressor & IndexedDB Asset Manager.
 *
 * Capabilities:
 *   - Pick images from mobile photo library via native file input
 *   - Resize & compress images to lightweight WebP using offscreen Canvas
 *   - Persist binary Blobs in IndexedDB (via StorageManager large layer)
 *   - Generate crisp, deterministic geometric SVG placeholders when no image is stored
 */

const ASSET_NAMESPACE = 'core-assets';

function hashString(str) {
  let h = 2166136261;
  const s = String(str || 'default');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PLACEHOLDER_PALETTES = [
  { bg1: '#141c27', bg2: '#0c1118', primary: '#14b8a6', secondary: '#2dd4bf', stroke: '#334155' },
  { bg1: '#161b29', bg2: '#0d1018', primary: '#38bdf8', secondary: '#818cf8', stroke: '#334155' },
  { bg1: '#1c1926', bg2: '#100e17', primary: '#a78bfa', secondary: '#34d399', stroke: '#3f3b54' },
  { bg1: '#1c1b18', bg2: '#11100e', primary: '#f59e0b', secondary: '#2dd4bf', stroke: '#44403c' },
  { bg1: '#121f24', bg2: '#0a1216', primary: '#22d3ee', secondary: '#14b8a6', stroke: '#2c414a' },
];

function escapeXml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Generate a sleek deterministic geometric SVG placeholder.
 * @param {string} [seed='asset']
 * @param {{ width?: number, height?: number, label?: string }} [options]
 */
export function generatePlaceholderSvg(seed = 'asset', { width = 240, height = 240, label = '' } = {}) {
  const h = hashString(seed);
  const palette = PLACEHOLDER_PALETTES[h % PLACEHOLDER_PALETTES.length];
  const pattern = h % 3;
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.28;
  const safeLabel = escapeXml(String(label || seed).slice(0, 12));

  let shapeSvg = '';
  if (pattern === 0) {
    shapeSvg = `
      <rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" rx="${r * 0.34}" fill="${palette.primary}" fill-opacity="0.18" stroke="${palette.primary}" stroke-width="2.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.56}" fill="${palette.secondary}" fill-opacity="0.28" stroke="${palette.secondary}" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.16}" fill="${palette.secondary}"/>
    `;
  } else if (pattern === 1) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
    }
    shapeSvg = `
      <polygon points="${pts.join(' ')}" fill="${palette.primary}" fill-opacity="0.18" stroke="${palette.primary}" stroke-width="2.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="none" stroke="${palette.secondary}" stroke-width="2" stroke-dasharray="6 5"/>
      <rect x="${cx - r * 0.18}" y="${cy - r * 0.18}" width="${r * 0.36}" height="${r * 0.36}" rx="4" transform="rotate(45 ${cx} ${cy})" fill="${palette.secondary}"/>
    `;
  } else {
    shapeSvg = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${palette.primary}" stroke-width="2.5" stroke-opacity="0.85"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.68}" fill="${palette.primary}" fill-opacity="0.16" stroke="${palette.secondary}" stroke-width="1.8"/>
      <path d="M ${cx - r * 0.5} ${cy} L ${cx} ${cy - r * 0.5} L ${cx + r * 0.5} ${cy} L ${cx} ${cy + r * 0.5} Z" fill="${palette.secondary}" fill-opacity="0.45"/>
    `;
  }

  const gradId = `g_${h.toString(16)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="${gradId}" cx="50%" cy="35%" r="75%">
      <stop offset="0%" stop-color="${palette.bg1}"/>
      <stop offset="100%" stop-color="${palette.bg2}"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="url(#${gradId})"/>
  <g stroke="${palette.stroke}" stroke-opacity="0.28" stroke-width="1">
    <line x1="0" y1="${height * 0.25}" x2="${width}" y2="${height * 0.25}"/>
    <line x1="0" y1="${height * 0.75}" x2="${width}" y2="${height * 0.75}"/>
    <line x1="${width * 0.25}" y1="0" x2="${width * 0.25}" y2="${height}"/>
    <line x1="${width * 0.75}" y1="0" x2="${width * 0.75}" y2="${height}"/>
  </g>
  <rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="14" fill="none" stroke="${palette.stroke}" stroke-opacity="0.45" stroke-width="1.2"/>
  ${shapeSvg}
  <text x="${cx}" y="${height - 20}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, sans-serif" font-size="12" fill="#94a3b8" letter-spacing="0.06em">${safeLabel}</text>
</svg>`;
}

export function generatePlaceholderDataUri(seed = 'asset', options = {}) {
  const svg = generatePlaceholderSvg(seed, options);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function decodeImageSource(blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => URL.revokeObjectURL(url),
      });
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err || new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function fitDimensions(srcWidth, srcHeight, maxWidth, maxHeight) {
  let w = Math.max(1, srcWidth);
  let h = Math.max(1, srcHeight);
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Downscale and compress an image File/Blob to lightweight WebP (with JPEG fallback if needed).
 * @param {Blob | File} file
 * @param {{ maxWidth?: number, maxHeight?: number, quality?: number, mimeType?: string }} [options]
 */
export async function compressImageFile(
  file,
  { maxWidth = 720, maxHeight = 720, quality = 0.78, mimeType = 'image/webp' } = {}
) {
  if (!(file instanceof Blob)) {
    throw new TypeError('compressImageFile 需要传入有效的 File 或 Blob 对象');
  }

  const decoded = await decodeImageSource(file);
  try {
    const { width, height } = fitDimensions(decoded.width, decoded.height, maxWidth, maxHeight);
    let outBlob = null;

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded.source, 0, 0, width, height);
      try {
        outBlob = await canvas.convertToBlob({ type: mimeType, quality });
      } catch {
        outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      }
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(decoded.source, 0, 0, width, height);

      outBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else {
              canvas.toBlob(
                (fallbackBlob) => (fallbackBlob ? resolve(fallbackBlob) : reject(new Error('Canvas 压缩导出失败'))),
                'image/jpeg',
                quality
              );
            }
          },
          mimeType,
          quality
        );
      });
    }

    const originalBytes = file.size;
    const compressedBytes = outBlob.size;
    const ratio = originalBytes > 0 ? Number((compressedBytes / originalBytes).toFixed(4)) : 1;

    return {
      blob: outBlob,
      mimeType: outBlob.type || mimeType,
      width,
      height,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
      originalBytes,
      compressedBytes,
      ratio,
    };
  } finally {
    decoded.cleanup();
  }
}

export class AssetManager {
  /**
   * @param {{ storage: import('./storage.js').StorageManager, bus?: import('./event-bus.js').EventBus | null }} deps
   */
  constructor({ storage, bus = null }) {
    this._storage = storage;
    this._scope = storage.namespace(ASSET_NAMESPACE);
    this._bus = bus;
    /** @type {Map<string, string>} */
    this._urlCache = new Map();
  }

  _emit(event, payload) {
    if (this._bus) {
      this._bus.emit(event, payload);
    }
  }

  _revokeUrl(id) {
    const cached = this._urlCache.get(id);
    if (cached) {
      URL.revokeObjectURL(cached);
      this._urlCache.delete(id);
    }
  }

  generatePlaceholderSvg(seed, options) {
    return generatePlaceholderSvg(seed, options);
  }

  generatePlaceholderDataUri(seed, options) {
    return generatePlaceholderDataUri(seed, options);
  }

  /**
   * Trigger native mobile gallery / file picker and resolve with chosen File (or null).
   */
  pickImageFromDevice({ accept = 'image/*', capture = null } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      if (capture) input.setAttribute('capture', String(capture));
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const done = (file) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(file || null);
      };

      input.addEventListener('change', () => {
        done(input.files?.[0] || null);
      });
      input.addEventListener('cancel', () => done(null));
      input.click();
    });
  }

  async compressImage(file, options) {
    return compressImageFile(file, options);
  }

  /**
   * Compress an image File/Blob to WebP and store it in IndexedDB.
   */
  async saveImageFromFile(
    file,
    { id = null, label = '', tags = [], maxWidth = 720, maxHeight = 720, quality = 0.78 } = {}
  ) {
    const assetId = String(id || `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    const compressed = await compressImageFile(file, { maxWidth, maxHeight, quality, mimeType: 'image/webp' });
    const record = {
      id: assetId,
      label: String(label || file.name || assetId),
      tags: Array.isArray(tags) ? [...tags] : [],
      blob: compressed.blob,
      mimeType: compressed.mimeType,
      width: compressed.width,
      height: compressed.height,
      originalWidth: compressed.originalWidth,
      originalHeight: compressed.originalHeight,
      originalBytes: compressed.originalBytes,
      compressedBytes: compressed.compressedBytes,
      ratio: compressed.ratio,
      createdAt: Date.now(),
    };

    this._revokeUrl(assetId);
    await this._scope.setLarge(assetId, record, { contentType: compressed.mimeType });
    this._emit('asset:saved', { id: assetId, meta: this._toMeta(record) });
    return this._toMeta(record);
  }

  _toMeta(record) {
    return {
      id: record.id,
      label: record.label,
      tags: record.tags || [],
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      originalWidth: record.originalWidth,
      originalHeight: record.originalHeight,
      originalBytes: record.originalBytes,
      compressedBytes: record.compressedBytes,
      ratio: record.ratio,
      createdAt: record.createdAt,
    };
  }

  async getAsset(id) {
    return this._scope.getLarge(String(id), null);
  }

  /**
   * Resolve an image URL from IndexedDB, or fall back seamlessly to a geometric SVG placeholder.
   */
  async getAssetUrl(id, { fallbackSeed = null, fallbackLabel = '' } = {}) {
    const cleanId = id ? String(id) : '';
    if (cleanId && this._urlCache.has(cleanId)) {
      return { url: this._urlCache.get(cleanId), isPlaceholder: false };
    }
    if (cleanId) {
      const rec = await this._scope.getLarge(cleanId, null);
      if (rec && rec.blob instanceof Blob) {
        const url = URL.createObjectURL(rec.blob);
        this._urlCache.set(cleanId, url);
        return { url, isPlaceholder: false, meta: this._toMeta(rec) };
      }
    }
    return {
      url: generatePlaceholderDataUri(fallbackSeed || cleanId || 'placeholder', {
        label: fallbackLabel || cleanId || 'ASSET',
      }),
      isPlaceholder: true,
    };
  }

  async listAssets() {
    const all = await this._scope.getAllLarge();
    return Object.values(all)
      .filter((r) => r && r.id)
      .map((r) => this._toMeta(r))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async deleteAsset(id) {
    const cleanId = String(id);
    this._revokeUrl(cleanId);
    await this._scope.removeLarge(cleanId);
    this._emit('asset:deleted', { id: cleanId });
    return true;
  }

  async clearAssets() {
    for (const id of Array.from(this._urlCache.keys())) {
      this._revokeUrl(id);
    }
    const count = await this._scope.clearLarge();
    this._emit('asset:cleared', { count });
    return count;
  }
}
