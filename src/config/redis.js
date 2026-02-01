const Redis = require('ioredis');

let redis;
if (process.env.REDIS_URL) {
	redis = new Redis(process.env.REDIS_URL, {
		retryStrategy: (times) => Math.min(times * 50, 2000),
		maxRetriesPerRequest: 3,
		commandTimeout: 5000
	});
} else {
	redis = new Redis({
		host: process.env.REDIS_HOST || '127.0.0.1',
		port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
		password: process.env.REDIS_PASSWORD || undefined,
		lazyConnect: false,
		retryStrategy: (times) => Math.min(times * 50, 2000),
		maxRetriesPerRequest: 3,
		commandTimeout: 5000
	});
}

redis.on('error', (err) => {
	console.error('Redis error:', err.message || err);
});

redis.on('connect', () => {
	console.log('✅ Redis connected');
});

redis.on('reconnecting', () => {
	console.log('🔄 Redis reconnecting...');
});

module.exports = redis;