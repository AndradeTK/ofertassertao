/**
 * Simple rate limiter to prevent bot spam and API abuse
 * Limits to 5 messages per minute
 */

class RateLimiter {
    constructor(maxMessages = 5, timeWindow = 60000) { // 5 messages per 60 seconds
        this.maxMessages = maxMessages;
        this.timeWindow = timeWindow;
        this.messageTimestamps = [];
    }

    /**
     * Check if we can process a new message
     * @returns {boolean} true if allowed, false if rate limited
     */
    canProcess() {
        const now = Date.now();
        
        // Remove timestamps older than the time window
        this.messageTimestamps = this.messageTimestamps.filter(
            timestamp => now - timestamp < this.timeWindow
        );

        // Check if we're under the limit
        if (this.messageTimestamps.length < this.maxMessages) {
            this.messageTimestamps.push(now);
            return true;
        }

        return false;
    }

    /**
     * Get current rate limit status
     */
    getStatus() {
        const now = Date.now();
        this.messageTimestamps = this.messageTimestamps.filter(
            timestamp => now - timestamp < this.timeWindow
        );

        return {
            current: this.messageTimestamps.length,
            max: this.maxMessages,
            timeWindow: this.timeWindow / 1000, // in seconds
            remaining: this.maxMessages - this.messageTimestamps.length
        };
    }

    /**
     * Reset the rate limiter
     */
    reset() {
        this.messageTimestamps = [];
    }
}

// Create a global instance
const globalRateLimiter = new RateLimiter(5, 60000); // 5 messages per minute

module.exports = {
    RateLimiter,
    globalRateLimiter
};
