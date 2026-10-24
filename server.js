const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// FFmpeg yolunu otomatik tanımla
ffmpeg.setFfmpegPath(ffmpegStatic);

// Klasör kontrolleri ve otomatik oluşturma
const uploadsDir = path.join(__dirname, 'uploads');
const outputsDir = path.join(__dirname, 'outputs');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(outputsDir)) {
  fs.mkdirSync(outputsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Türkçe karakter ve boşluk sorunlarını önlemek için dosya adı sanitize fonksiyonu
function sanitizeFileName(filename) {
  const turkishMap = {
    ç: 'c', Ç: 'C',
    ğ: 'g', Ğ: 'G',
    ı: 'i', İ: 'I',
    ö: 'o', Ö: 'O',
    ş: 's', Ş: 'S',
    ü: 'u', Ü: 'U'
  };

  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);

  const sanitizedBase = baseName
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (match) => turkishMap[match] || match)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'video';

  const sanitizedExt = ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.mp4';
  return {
    base: sanitizedBase,
    ext: sanitizedExt,
    full: `${sanitizedBase}${sanitizedExt}`
  };
}

// Zaman dizgesini (HH:MM:SS veya MM:SS veya SS) saniyeye çevirir
function parseTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const trimmed = timeStr.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  return null;
}

// Güvenli dosya silme yardımcı fonksiyonu
function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`Dosya silinemedi (${filePath}):`, err.message);
    }
  });
}

// Multer yapılandırması
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Multer latin1 encoding düzeltmesi
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const sanitized = sanitizeFileName(originalName);
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${uniqueSuffix}-${sanitized.full}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024 // 2GB limit
  }
});

// POST /convert endpoint'i (tekli 'video' veya çoklu 'videos' alanlarını destekler)
app.post('/convert', upload.any(), (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'Lütfen dönüştürülecek bir video dosyası yükleyin.' });
  }

  const inputFile = files[0];
  const inputPath = inputFile.path;

  // Eğer birden fazla dosya gönderildiyse diğer geçici dosyaları da takip et
  const extraFiles = files.slice(1).map((f) => f.path);
  extraFiles.forEach(safeUnlink);

  // Parametreleri al ve doğrula
  const rawFormat = (req.body.format || 'mp3').toLowerCase().trim();
  const format = rawFormat === 'wav' ? 'wav' : 'mp3';

  const validBitrates = ['128k', '192k', '320k'];
  const rawBitrate = (req.body.bitrate || '192k').toLowerCase().trim();
  const bitrate = validBitrates.includes(rawBitrate) ? rawBitrate : '192k';

  const startTime = req.body.startTime ? req.body.startTime.trim() : '';
  const endTime = req.body.endTime ? req.body.endTime.trim() : '';

  // Orijinal dosya adını sanitize ederek çıktı adını oluştur
  const originalName = Buffer.from(inputFile.originalname, 'latin1').toString('utf8');
  const sanitized = sanitizeFileName(originalName);
  const outputFileName = `${sanitized.base}-${Date.now()}.${format}`;
  const downloadFileName = `${sanitized.base}.${format}`;
  const outputPath = path.join(outputsDir, outputFileName);

  // Zaman doğrulaması
  const startSec = parseTimeToSeconds(startTime);
  const endSec = parseTimeToSeconds(endTime);

  if (startTime && startSec === null) {
    safeUnlink(inputPath);
    return res.status(400).json({ error: 'Geçersiz başlangıç zamanı formatı. Örn: 00:00:15' });
  }

  if (endTime && endSec === null) {
    safeUnlink(inputPath);
    return res.status(400).json({ error: 'Geçersiz bitiş zamanı formatı. Örn: 00:02:30' });
  }

  if (startSec !== null && endSec !== null && endSec <= startSec) {
    safeUnlink(inputPath);
    return res.status(400).json({ error: 'Bitiş zamanı başlangıç zamanından büyük olmalıdır.' });
  }

  let command = ffmpeg(inputPath).noVideo();

  // Başlangıç ve bitiş süresi ayarları
  if (startTime) {
    command = command.setStartTime(startTime);
  }

  if (endTime) {
    if (startSec !== null && endSec !== null) {
      const duration = endSec - startSec;
      command = command.setDuration(duration);
    } else {
      command = command.outputOptions([`-to ${endTime}`]);
    }
  }

  // Format ve codec ayarları
  if (format === 'mp3') {
    command = command
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate)
      .toFormat('mp3');
  } else {
    command = command
      .audioCodec('pcm_s16le')
      .toFormat('wav');
  }

  let cleanedUp = false;
  const cleanupFiles = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    safeUnlink(inputPath);
    safeUnlink(outputPath);
  };

  command
    .on('error', (err) => {
      console.error('FFmpeg Dönüştürme Hatası:', err.message);
      cleanupFiles();
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Video sese dönüştürülürken bir hata oluştu.',
          details: err.message
        });
      }
    })
    .on('end', () => {
      res.setHeader('X-Download-Filename', downloadFileName);
      res.download(outputPath, downloadFileName, (err) => {
        if (err) {
          console.error('Dosya İndirme Hatası:', err.message);
        }
        cleanupFiles();
      });
    })
    .save(outputPath);
});

app.listen(PORT, () => {
  console.log(`🚀 Video -> Ses Dönüştürücü Sunucusu çalışıyor: http://localhost:${PORT}`);
});
