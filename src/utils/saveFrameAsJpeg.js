const { spawn } = require('node:child_process');

/**
 * Передает один сырой BGR-кадр отдельному процессу FFmpeg
 * и сохраняет его в формате JPEG.
 *
 * @param {object} options
 * @param {string} options.ffmpegPath Путь к FFmpeg.
 * @param {Buffer} options.frameBuffer Данные кадра BGR24.
 * @param {number} options.width Ширина кадра.
 * @param {number} options.height Высота кадра.
 * @param {string} options.outputPath Путь к итоговому JPEG.
 * @returns {Promise<void>}
 */
function saveFrameAsJpeg({
  ffmpegPath,
  frameBuffer,
  width,
  height,
  outputPath,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',

      // Вход представляет собой один сырой кадр.
      '-f',
      'rawvideo',

      '-pix_fmt',
      'bgr24',

      '-video_size',
      `${width}x${height}`,

      '-i',
      'pipe:0',

      // Сохраняем только один кадр.
      '-frames:v',
      '1',

      // Перезаписываем существующий файл.
      '-y',

      outputPath,
    ];

    const process = spawn(ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let errorOutput = '';

    process.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString('utf8');
    });

    process.on('error', reject);

    process.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Не удалось сохранить JPEG. Код FFmpeg: ${code}. ` +
            `${errorOutput.trim()}`,
        ),
      );
    });

    process.stdin.on('error', reject);

    /**
     * Передаем ровно один кадр и закрываем stdin.
     */
    process.stdin.end(frameBuffer);
  });
}

module.exports = saveFrameAsJpeg;
