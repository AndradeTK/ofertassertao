const fs = require('fs');
const { pool } = require('../config/db');
const { createComponentLogger } = require('../config/logger');

const logger = createComponentLogger('ScheduledPosts');

/**
 * Process scheduled posts that are ready to be posted
 * Runs every minute to check for pending posts
 */
async function processScheduledPosts() {
    try {
        // Get all pending posts that are due
        const [posts] = await pool.execute(`
            SELECT id, content, image_url, schedule_time
            FROM scheduled_posts
            WHERE status = 'pending' AND schedule_time <= NOW()
            ORDER BY schedule_time ASC
        `);

        if (posts.length === 0) {
            // Silent return - don't log every check
            return;
        }

        logger.info(`Found ${posts.length} scheduled post(s) ready to process`);
        console.log(`[Scheduled Posts] ⏰ Found ${posts.length} post(s) ready to process`);

        for (const post of posts) {
            try {
                // Import handlePromotionFlow here to avoid circular dependencies
                const { handlePromotionFlow } = require('./promotionFlow');

                logger.info(`Processing scheduled post #${post.id} (scheduled for ${post.schedule_time})`);
                console.log(`[Scheduled Post #${post.id}] 📤 Processing (scheduled for ${post.schedule_time})...`);

                // Process through the same flow as monitored messages
                // This ensures IA classification, affiliate links, etc.
                let imageSource = null;
                if (post.image_url) {
                    // image_url can be either a file path or a Telegram file_id
                    const isPath = post.image_url.startsWith('/') || post.image_url.includes('\\') || post.image_url.includes('uploads');
                    
                    if (isPath) {
                        // It's a file path
                        if (fs.existsSync(post.image_url)) {
                            logger.info(`Loading image from: ${post.image_url}`);
                            console.log(`[Scheduled Post #${post.id}] 📸 Loading image from: ${post.image_url}`);
                            imageSource = { source: fs.readFileSync(post.image_url) };
                        } else {
                            logger.warn(`Image file not found: ${post.image_url}`);
                            console.warn(`[Scheduled Post #${post.id}] ⚠️ Image file not found: ${post.image_url}`);
                        }
                    } else {
                        // It's a Telegram file_id
                        logger.info('Using Telegram file_id');
                        console.log(`[Scheduled Post #${post.id}] 📸 Using Telegram file_id`);
                        imageSource = post.image_url;
                    }
                }

                // Call the same flow as monitored channels
                await handlePromotionFlow(post.content, null, imageSource);

                // Mark as posted
                await pool.execute(
                    'UPDATE scheduled_posts SET status = ?, posted_at = NOW() WHERE id = ?',
                    ['posted', post.id]
                );

                logger.info(`Scheduled post #${post.id} posted successfully`);
                console.log(`[Scheduled Post #${post.id}] ✅ Posted successfully`);

                // Log to system_logs
                await pool.execute(
                    'INSERT INTO system_logs (type, message, details, timestamp) VALUES (?, ?, ?, NOW())',
                    ['success', 'Postagem agendada enviada com sucesso', `Post #${post.id}`]
                );
            } catch (err) {
                logger.error(`Scheduled post #${post.id} failed: ${err.message}`);
                console.error(`[Scheduled Post #${post.id}] ❌ Error:`, err.message);

                // Mark as failed with error message
                await pool.execute(
                    'UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?',
                    ['failed', err.message, post.id]
                );

                // Log to system_logs
                await pool.execute(
                    'INSERT INTO system_logs (type, message, details, timestamp) VALUES (?, ?, ?, NOW())',
                    ['error', 'Falha ao enviar postagem agendada', `Post #${post.id}: ${err.message}`]
                );
            }
        }
    } catch (err) {
        logger.error(`Fatal error in processScheduledPosts: ${err.message}`, { stack: err.stack });
        console.error('[Scheduled Posts] 💥 Fatal error:', err);
    }
}

/**
 * Start the scheduled posts processor
 * This should be called once when the server starts
 */
function startScheduledPostsProcessor() {
    logger.info('Starting scheduled posts processor (checks every 30 seconds)');
    console.log('[Scheduled Posts] 🚀 Starting processor (checks every 30 seconds)');

    // Run immediately on startup
    processScheduledPosts().catch(err => {
        logger.error(`Startup error: ${err.message}`);
        console.error('[Scheduled Posts] Startup error:', err);
    });

    // Then run every 30 seconds
    const intervalId = setInterval(() => {
        processScheduledPosts().catch(err => {
            logger.error(`Interval error: ${err.message}`);
            console.error('[Scheduled Posts] Interval error:', err);
        });
    }, 30000); // 30 seconds
    
    // Keep the interval reference
    process.scheduledPostsInterval = intervalId;
    console.log('[Scheduled Posts] ✅ Processor running at intervals of 30 seconds');
}

module.exports = {
    processScheduledPosts,
    startScheduledPostsProcessor
};
