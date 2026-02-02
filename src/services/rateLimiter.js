/**
 * Simple rate limiter to prevent bot spam and API abuse
 * Configurable limits - can be changed via admin panel
 */

class RateLimiter {
    constructor(maxMessages = 5, timeWindow = 60000) { // 5 messages per 60 seconds
        this.maxMessages = maxMessages;
        this.timeWindow = timeWindow;
        this.messageTimestamps = [];
        this.onStatusChange = null; // Callback for status updates
    }

    /**
     * Set callback for status changes
     */
    setStatusChangeCallback(callback) {
        this.onStatusChange = callback;
    }

    /**
     * Notify status change
     */
    notifyStatusChange() {
        if (this.onStatusChange) {
            this.onStatusChange(this.getStatusForBroadcast());
        }
    }

    /**
     * Update rate limit settings
     */
    updateSettings(maxMessages, timeWindowSeconds) {
        this.maxMessages = parseInt(maxMessages) || 5;
        this.timeWindow = (parseInt(timeWindowSeconds) || 60) * 1000;
        console.log(`[RateLimiter] ⚙️ Configuração atualizada: ${this.maxMessages} mensagens por ${timeWindowSeconds}s`);
        this.notifyStatusChange();
    }

    /**
     * Get current settings
     */
    getSettings() {
        return {
            maxMessages: this.maxMessages,
            timeWindowSeconds: this.timeWindow / 1000
        };
    }

    /**
     * Check if we can process a new message (without consuming a slot)
     * @returns {boolean} true if allowed, false if rate limited
     */
    checkLimit() {
        const now = Date.now();
        
        // Remove timestamps older than the time window
        this.messageTimestamps = this.messageTimestamps.filter(
            timestamp => now - timestamp < this.timeWindow
        );

        // Check if we're under the limit
        return this.messageTimestamps.length < this.maxMessages;
    }

    /**
     * Consume a rate limit slot (call this when actually sending a message)
     * @returns {boolean} true if slot consumed, false if rate limited
     */
    consumeSlot() {
        const now = Date.now();
        
        // Remove timestamps older than the time window
        this.messageTimestamps = this.messageTimestamps.filter(
            timestamp => now - timestamp < this.timeWindow
        );

        // Check if we're under the limit
        if (this.messageTimestamps.length < this.maxMessages) {
            this.messageTimestamps.push(now);
            this.notifyStatusChange();
            return true;
        }

        return false;
    }

    /**
     * Check if we can process a new message (LEGACY - consumes slot immediately)
     * @deprecated Use checkLimit() + consumeSlot() instead
     * @returns {boolean} true if allowed, false if rate limited
     */
    canProcess() {
        return this.consumeSlot();
    }

    /**
     * Get current rate limit status
     */
    getStatus() {
        const now = Date.now();
        this.messageTimestamps = this.messageTimestamps.filter(
            timestamp => now - timestamp < this.timeWindow
        );

        // Calculate time until next slot is available
        let timeUntilNext = 0;
        if (this.messageTimestamps.length >= this.maxMessages && this.messageTimestamps.length > 0) {
            const oldestTimestamp = Math.min(...this.messageTimestamps);
            timeUntilNext = Math.max(0, (oldestTimestamp + this.timeWindow - now) / 1000);
        }

        return {
            current: this.messageTimestamps.length,
            max: this.maxMessages,
            timeWindow: this.timeWindow / 1000, // in seconds
            remaining: Math.max(0, this.maxMessages - this.messageTimestamps.length),
            timeUntilNext: Math.ceil(timeUntilNext)
        };
    }

    /**
     * Get status formatted for broadcast
     */
    getStatusForBroadcast() {
        const status = this.getStatus();
        return {
            current: status.current,
            maxMessages: status.max,
            timeWindowSeconds: status.timeWindow,
            remaining: status.remaining,
            timeUntilNext: status.timeUntilNext
        };
    }

    /**
     * Reset the rate limiter
     */
    reset() {
        this.messageTimestamps = [];
        this.notifyStatusChange();
    }
}

// Create a global instance
const globalRateLimiter = new RateLimiter(5, 60000); // 5 messages per minute

module.exports = {
    RateLimiter,
    globalRateLimiter
};
