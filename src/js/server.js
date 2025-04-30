require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cron = require('node-cron');
const winston = require('winston');
const axios = require('axios');
const retry = require('async-retry');
const { createClient } = require('redis');
const { check, validationResult } = require('express-validator');
const Bottleneck = require('bottleneck');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');

/**
 * @typedef {Object} Video
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} thumbnail
 */

/**
 * @typedef {Object} PlatformConfig
 * @property {string} [API_KEY]
 * @property {string} [CHANNEL_ID]
 * @property {string} [ACCESS_TOKEN]
 * @property {string} [OWNER_ID]
 * @property {(key: string, id: string) => string} apiUrl
 * @property {(key: string, id: string) => string} subscriberCountUrl
 */

/**
 * @typedef {Object} AppConfig
 * @property {PlatformConfig} youtube
 * @property {PlatformConfig} vk
 */

/**
 * @typedef {Object} Logger
 * @property {(message: string, meta?: any) => void} info
 * @property {(message: string, meta?: any) => void} error
 * @property {(message: string, meta?: any) => void} warn
 */

/**
 * @typedef {Object} Dependencies
 * @property {typeof axios} axios
 * @property {ReturnType<typeof createClient>} redisClient
 * @property {NodeCache} localCache
 */

// Ошибка API
class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}

// Утилиты
/**
 * Форматирует число с разделением тысяч
 * @param {number} number
 * @returns {string}
 */
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Обрабатывает ответ API для видео
 * @param {Object} item
 * @param {string} platform
 * @returns {Video}
 */
function mapVideoItem(item, platform) {
  if (platform === 'youtube') {
    return {
      id: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description || 'No description',
      thumbnail: item.snippet.thumbnails.maxres?.url || item.snippet.thumbnails.high?.url || '',
    };
  }
  return {
    id: `${item.owner_id}_${item.id}`,
    title: item.title,
    description: item.description || 'No description',
    thumbnail: item.photo_800 || item.photo_640 || item.photo_320 || '',
  };
}

// Leader Election
/**
 * Проверяет, является ли текущий процесс лидером
 * @param {Dependencies['redisClient']} redisClient
 * @returns {Promise<boolean>}
 */
async function isLeader(redisClient) {
  try {
    const result = await redisClient.setNX('leader', '1');
    if (result) {
      await redisClient.expire('leader', 60); // Лидер на 60 секунд
    }
    return result;
  } catch (error) {
    logger.error('Leader election failed, assuming leader', { error: error.message });
    return true; // Fallback для макета
  }
}

// Конфигурация
const config = {
  youtube: {
    API_KEY: process.env.YOUTUBE_API_KEY || '',
    CHANNEL_ID: process.env.YOUTUBE_CHANNEL_ID || '',
    apiUrl: (key, channelId) =>
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&maxResults=20&type=video&key=${key}`,
    subscriberCountUrl: (key, channelId) =>
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${key}`,
  },
  vk: {
    ACCESS_TOKEN: process.env.VK_ACCESS_TOKEN || '',
    OWNER_ID: process.env.VK_OWNER_ID || '',
    apiUrl: (token, ownerId) =>
      `https://api.vk.com/method/video.get?owner_id=${ownerId}&count=20&access_token=${token}&v=5.199`,
    subscriberCountUrl: (token, groupId) =>
      `https://api.vk.com/method/groups.getById?group_id=${groupId}&fields=members_count&access_token=${token}&v=5.199`,
  },
};

// Логгер
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format((info) => {
      // Фильтрация чувствительных данных
      if (info.error && typeof info.error === 'string') {
        info.error = info.error.replace(/token=[^&]+/, 'token=[REDACTED]');
      }
      return info;
    })()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console(),
  ],
});

// Зависимости
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redisClient.on('error', (err) => logger.error('Redis Client Error', { error: err.message }));
redisClient.connect();

const localCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // Локальный кэш на 10 минут
const limiter = new Bottleneck({ maxConcurrent: 5, minTime: 200 }); // 5 запросов одновременно, 200ms интервал
const dependencies = { axios, redisClient, localCache };

// Константы
const CACHE_KEYS = {
  youtube: {
    videos: 'youtube:videos',
    subscriberCount: 'youtube:subscriberCount',
    videosLastUpdated: 'youtube:videosLastUpdated',
    subscriberLastUpdated: 'youtube:subscriberLastUpdated',
  },
  vk: {
    videos: 'vk:videos',
    subscriberCount: 'vk:subscriberCount',
    videosLastUpdated: 'vk:videosLastUpdated',
    subscriberLastUpdated: 'vk:subscriberLastUpdated',
  },
};

const VIDEO_UPDATE_INTERVAL = 1 * 60 * 60 * 1000; // 1 час
const SUBSCRIBER_UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 часа

// Сервисы видео
/**
 * Сервис для получения видео с YouTube
 */
class YoutubeVideoService {
  /**
   * @param {Dependencies} deps
   */
  constructor(deps) {
    this.axios = deps.axios;
  }

  /**
   * Получает видео с YouTube
   * @param {AppConfig} config
   * @param {Logger} logger
   * @returns {Promise<Video[]>}
   */
  async fetchVideos(config, logger) {
    return limiter.schedule(() =>
      retry(
        async () => {
          const response = await this.axios.get(
            config.youtube.apiUrl(config.youtube.API_KEY, config.youtube.CHANNEL_ID)
          );
          if (!response.data.items) {
            logger.warn('YouTube API: No video data');
            return [];
          }
          return response.data.items.map((item) => mapVideoItem(item, 'youtube'));
        },
        {
          retries: 3,
          factor: 2,
          minTimeout: 1000,
          onRetry: (err) => logger.warn('Retrying YouTube fetch', { error: err.message }),
        }
      )
    );
  }
}

/**
 * Сервис для получения видео с VK
 */
class VkVideoService {
  /**
   * @param {Dependencies} deps
   */
  constructor(deps) {
    this.axios = deps.axios;
  }

  /**
   * Получает видео с VK
   * @param {AppConfig} config
   * @param {Logger} logger
   * @returns {Promise<Video[]>}
   */
  async fetchVideos(config, logger) {
    return limiter.schedule(() =>
      retry(
        async () => {
          const response = await this.axios.get(config.vk.apiUrl(config.vk.ACCESS_TOKEN, config.vk.OWNER_ID));
          if (!response.data.response?.items) {
            logger.warn('VK API: No video data');
            return [];
          }
          return response.data.response.items.map((item) => mapVideoItem(item, 'vk'));
        },
        {
          retries: 3,
          factor: 2,
          minTimeout: 1000,
          onRetry: (err) => logger.warn('Retrying VK fetch', { error: err.message }),
        }
      )
    );
  }
}

// Сервисы подписчиков
/**
 * Сервис для получения подписчиков с YouTube
 */
class YoutubeSubscriberService {
  /**
   * @param {Dependencies} deps
   */
  constructor(deps) {
    this.axios = deps.axios;
  }

  /**
   * Получает количество подписчиков с YouTube
   * @param {AppConfig} config
   * @param {Logger} logger
   * @returns {Promise<string>}
   */
  async fetchSubscribers(config, logger) {
    return limiter.schedule(() =>
      retry(
        async () => {
          const response = await this.axios.get(
            config.youtube.subscriberCountUrl(config.youtube.API_KEY, config.youtube.CHANNEL_ID)
          );
          if (response.data.items?.[0]) {
            return formatNumber(response.data.items[0].statistics.subscriberCount);
          }
          logger.warn('YouTube API: No subscriber data, using fallback');
          return '631 000';
        },
        {
          retries: 3,
          factor: 2,
          minTimeout: 1000,
          onRetry: (err) => logger.warn('Retrying YouTube subscribers', { error: err.message }),
        }
      )
    );
  }
}

/**
 * Сервис для получения подписчиков с VK
 */
class VkSubscriberService {
  /**
   * @param {Dependencies} deps
   */
  constructor(deps) {
    this.axios = deps.axios;
  }

  /**
   * Получает количество подписчиков с VK
   * @param {AppConfig} config
   * @param {Logger} logger
   * @returns {Promise<string>}
   */
  async fetchSubscribers(config, logger) {
    return limiter.schedule(() =>
      retry(
        async () => {
          const response = await this.axios.get(
            config.vk.subscriberCountUrl(config.vk.ACCESS_TOKEN, config.vk.OWNER_ID.replace('-', ''))
          );
          if (response.data.response?.[0]) {
            return formatNumber(response.data.response[0].members_count);
          }
          logger.warn('VK API: No subscriber data, using fallback');
          return '123 000';
        },
        {
          retries: 3,
          factor: 2,
          minTimeout: 1000,
          onRetry: (err) => logger.warn('Retrying VK subscribers', { error: err.message }),
        }
      )
    );
  }
}

// Кэш
/**
 * Получает данные из кэша или обновляет их
 * @param {string} platform
 * @param {AppConfig} config
 * @param {Logger} logger
 * @param {Dependencies} deps
 * @returns {Promise<{videos: Video[], subscriberCount: string}>}
 */
async function getCachedData(platform, config, logger, deps) {
  const cache = CACHE_KEYS[platform];
  const correlationId = uuidv4(); // Корреляционный ID для логов
  let videos, subscriberCount, videosLastUpdated, subscriberLastUpdated;

  // Пробуем получить из Redis
  try {
    videos = await deps.redisClient.get(cache.videos);
    subscriberCount = await deps.redisClient.get(cache.subscriberCount);
    videosLastUpdated = parseInt(await deps.redisClient.get(cache.videosLastUpdated) || '0');
    subscriberLastUpdated = parseInt(await deps.redisClient.get(cache.subscriberLastUpdated) || '0');
  } catch (error) {
    logger.error('Redis fetch failed, using local cache', { correlationId, error: error.message });
    // Fallback на локальный кэш
    videos = deps.localCache.get(cache.videos) || '[]';
    subscriberCount = deps.localCache.get(cache.subscriberCount) || (platform === 'youtube' ? '631 000' : '123 000');
    videosLastUpdated = deps.localCache.get(cache.videosLastUpdated) || 0;
    subscriberLastUpdated = deps.localCache.get(cache.subscriberLastUpdated) || 0;
  }

  videos = videos ? JSON.parse(videos) : [];
  subscriberCount = subscriberCount || (platform === 'youtube' ? '631 000' : '123 000');

  // Обновляем, если кэш устарел
  if (Date.now() - videosLastUpdated > VIDEO_UPDATE_INTERVAL) {
    videos = await updateVideos(platform, config, logger, deps, correlationId);
  }
  if (Date.now() - subscriberLastUpdated > SUBSCRIBER_UPDATE_INTERVAL) {
    subscriberCount = await updateSubscribers(platform, config, logger, deps, correlationId);
  }

  return { videos, subscriberCount };
}

/**
 * Обновляет видео в кэше
 * @param {string} platform
 * @param {AppConfig} config
 * @param {Logger} logger
 * @param {Dependencies} deps
 * @param {string} correlationId
 * @returns {Promise<Video[]>}
 */
async function updateVideos(platform, config, logger, deps, correlationId) {
  const cache = CACHE_KEYS[platform];
  const service = platform === 'youtube' ? new YoutubeVideoService(deps) : new VkVideoService(deps);
  const videos = await service.fetchVideos(config, logger);

  try {
    await deps.redisClient
      .multi()
      .set(cache.videos, JSON.stringify(videos))
      .set(cache.videosLastUpdated, Date.now().toString())
      .exec();
    deps.localCache.set(cache.videos, JSON.stringify(videos));
    deps.localCache.set(cache.videosLastUpdated, Date.now());
    logger.info(`Videos cache updated for ${platform}: ${videos.length} videos`, { correlationId });
  } catch (error) {
    logger.error('Redis update failed, using local cache', { correlationId, error: error.message });
    deps.localCache.set(cache.videos, JSON.stringify(videos));
    deps.localCache.set(cache.videosLastUpdated, Date.now());
  }

  return videos;
}

/**
 * Обновляет подписчиков в кэше
 * @param {string} platform
 * @param {AppConfig} config
 * @param {Logger} logger
 * @param {Dependencies} deps
 * @param {string} correlationId
 * @returns {Promise<string>}
 */
async function updateSubscribers(platform, config, logger, deps, correlationId) {
  const cache = CACHE_KEYS[platform];
  const service = platform === 'youtube' ? new YoutubeSubscriberService(deps) : new VkSubscriberService(deps);
  const subscriberCount = await service.fetchSubscribers(config, logger);

  try {
    await deps.redisClient
      .multi()
      .set(cache.subscriberCount, subscriberCount)
      .set(cache.subscriberLastUpdated, Date.now().toString())
      .exec();
    deps.localCache.set(cache.subscriberCount, subscriberCount);
    deps.localCache.set(cache.subscriberLastUpdated, Date.now());
    logger.info(`Subscribers cache updated for ${platform}: ${subscriberCount}`, { correlationId });
  } catch (error) {
    logger.error('Redis update failed, using local cache', { correlationId, error: error.message });
    deps.localCache.set(cache.subscriberCount, subscriberCount);
    deps.localCache.set(cache.subscriberLastUpdated, Date.now());
  }

  return subscriberCount;
}

// Graceful Shutdown
/**
 * Настраивает graceful shutdown
 * @param {Dependencies} deps
 */
function setupGracefulShutdown(deps) {
  process.on('SIGINT', () => shutdown(deps));
  process.on('SIGTERM', () => shutdown(deps));
}

/**
 * Выполняет graceful shutdown
 * @param {Dependencies} deps
 */
async function shutdown(deps) {
  logger.info('Graceful shutdown initiated...');
  try {
    await deps.redisClient.quit();
    logger.info('Redis connection closed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

// Контроллер
/**
 * Получает видео и подписчиков
 * @type {Array<import('express').RequestHandler>}
 */
const getVideos = [
  check('platform').isIn(['youtube', 'vk']).withMessage('Invalid platform'),
  check('maxResults').optional().isInt({ min: 1, max: 50 }).withMessage('maxResults must be between 1 and 50'),
  async (req, res, next) => {
    const correlationId = uuidv4();
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new APIError(errors.array()[0].msg, 400);
      }

      const platform = req.params.platform;
      const maxResults = parseInt(req.query.maxResults) || 20; // Поддержка фильтрации
      const { videos, subscriberCount } = await getCachedData(platform, config, logger, dependencies, correlationId);

      // Ограничение количества видео
      const limitedVideos = videos.slice(0, maxResults);
      res.set('ETag', `${platform}-${limitedVideos.length}-${subscriberCount}`);
      res.json({ videos: limitedVideos, subscriberCount });
    } catch (error) {
      logger.error('Error in getVideos', { correlationId, error: error.message });
      next(error);
    }
  },
];

// Приложение
const app = express();
const port = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(express.json());
app.use(compression());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests' },
  })
);

// Периодические задачи
isLeader(redisClient).then((leader) => {
  if (leader) {
    cron.schedule('0 * * * *', async () => {
      const correlationId = uuidv4();
      try {
        await updateVideos('youtube', config, logger, dependencies, correlationId);
        await updateVideos('vk', config, logger, dependencies, correlationId);
        logger.info('Scheduled videos update', { correlationId });
      } catch (error) {
        logger.error('Scheduled videos update failed', { correlationId, error: error.message });
      }
    });

    cron.schedule('0 0 * * *', async () => {
      const correlationId = uuidv4();
      try {
        await updateSubscribers('youtube', config, logger, dependencies, correlationId);
        await updateSubscribers('vk', config, logger, dependencies, correlationId);
        logger.info('Scheduled subscribers update', { correlationId });
      } catch (error) {
        logger.error('Scheduled subscribers update failed', { correlationId, error: error.message });
      }
    });
  }
});

// Эндпоинты
app.get('/api/videos/:platform', getVideos);

/**
 * Health check
 */
app.get('/api/health', async (req, res) => {
  const correlationId = uuidv4();
  try {
    const redisPing = await redisClient.ping();
    const youtubeOk = !!config.youtube.API_KEY;
    const vkOk = !!config.vk.ACCESS_TOKEN;
    const status = redisPing === 'PONG' && youtubeOk && vkOk ? 'ok' : 'error';
    res.json({
      status,
      serverTime: new Date().toISOString(),
      redis: redisPing === 'PONG' ? 'ok' : 'error',
      youtube: youtubeOk ? 'ok' : 'error',
      vk: vkOk ? 'ok' : 'error',
    });
  } catch (error) {
    logger.error('Health check failed', { correlationId, error: error.message });
    res.status(500).json({
      status: 'error',
      serverTime: new Date().toISOString(),
      redis: 'error',
      youtube: 'unknown',
      vk: 'unknown',
    });
  }
});

// Ошибки
app.use((error, req, res, _next) => {
  const correlationId = req.correlationId || uuidv4();
  logger.error('Request error', { path: req.path, error: error.message, stack: error.stack, correlationId });
  if (error instanceof APIError) {
    return res.status(error.status).json({ error: error.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// Запуск сервера
app.listen(port, async () => {
  logger.info(`Server running on http://localhost:${port}`);
  const correlationId = uuidv4();
  try {
    await updateVideos('youtube', config, logger, dependencies, correlationId);
    await updateVideos('vk', config, logger, dependencies, correlationId);
    await updateSubscribers('youtube', config, logger, dependencies, correlationId);
    await updateSubscribers('vk', config, logger, dependencies, correlationId);
  } catch (error) {
    logger.error('Error initializing cache', { correlationId, error: error.message });
  }
});

// Graceful Shutdown
setupGracefulShutdown(dependencies);

// Пример юнит-теста (Jest)
/*
describe('YoutubeVideoService', () => {
  const mockAxios = { get: jest.fn() };
  const deps = { axios: mockAxios, redisClient: {}, localCache: new NodeCache() };
  const service = new YoutubeVideoService(deps);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  test('fetchVideos returns mapped videos', async () => {
    mockAxios.get.mockResolvedValue({
      data: { items: [{ id: { videoId: '123' }, snippet: { title: 'Test', thumbnails: { high: { url: 'url' } } } }] },
    });
    const videos = await service.fetchVideos(config, logger);
    expect(videos).toEqual([{ id: '123', title: 'Test', description: 'No description', thumbnail: 'url' }]);
  });
});
*/