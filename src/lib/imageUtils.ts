export const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB
export const SUPPORTED_IMAGE_FORMATS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface ImageInfo {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

export async function readImageFile(file: File): Promise<ImageInfo> {
  if (!SUPPORTED_IMAGE_FORMATS.includes(file.type)) {
    throw new Error(`不支持的图片格式: ${file.type}。仅支持 PNG、JPEG、WebP、GIF`);
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error(`图片大小超过限制: ${(file.size / 1024 / 1024).toFixed(2)}MB > 50MB`);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const base64 = (e.target?.result as string).split(',')[1];
        if (!base64) {
          throw new Error('图片编码失败');
        }

        // 使用 Image API 获取尺寸
        const img = new Image();
        img.onload = () => {
          resolve({
            base64,
            mimeType: file.type,
            width: img.width,
            height: img.height,
            size: file.size,
          });
        };
        img.onerror = () => {
          reject(new Error('无法读取图片尺寸'));
        };
        img.src = e.target?.result as string;
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = () => {
      reject(new Error('图片读取失败'));
    };

    reader.readAsDataURL(file);
  });
}

/**
 * 计算图片的token成本
 * 根据 OpenAI 文档中的 GPT-4o 计算方式
 * https://platform.openai.com/docs/guides/vision/calculating-costs
 */
export function calculateImageTokens(
  width: number,
  height: number,
  detail: 'low' | 'high' | 'auto' = 'auto'
): number {
  const BASE_TOKENS = 85; // gpt-4o base tokens
  const TILE_TOKENS = 170; // gpt-4o tile tokens
  const TILE_SIZE = 512;

  // 'low' detail cost is fixed
  if (detail === 'low') {
    return BASE_TOKENS;
  }

  // For 'high' or 'auto', calculate based on image size
  // Scale to fit in a 2048px x 2048px square
  let scaledWidth = width;
  let scaledHeight = height;

  if (width > 2048 || height > 2048) {
    const ratio = Math.min(2048 / width, 2048 / height);
    scaledWidth = Math.floor(width * ratio);
    scaledHeight = Math.floor(height * ratio);
  }

  // Scale so shortest side is 768px
  const minDim = Math.min(scaledWidth, scaledHeight);
  if (minDim > 768) {
    const ratio = 768 / minDim;
    scaledWidth = Math.floor(scaledWidth * ratio);
    scaledHeight = Math.floor(scaledHeight * ratio);
  }

  // Count the number of 512px tiles needed
  const tilesX = Math.ceil(scaledWidth / TILE_SIZE);
  const tilesY = Math.ceil(scaledHeight / TILE_SIZE);
  const totalTiles = tilesX * tilesY;

  return BASE_TOKENS + totalTiles * TILE_TOKENS;
}

/**
 * 在 'auto' detail mode 下，根据图片大小智能选择
 */
export function selectDetailLevel(width: number, height: number): 'low' | 'high' {
  // 如果图片较小（短边 < 512px），使用 low 以节省成本
  const minDim = Math.min(width, height);
  return minDim < 512 ? 'low' : 'high';
}
