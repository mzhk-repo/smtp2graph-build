import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import chokidar from 'chokidar';
import { Mutex } from 'async-mutex';
import { Mailer } from './Mailer';
import { prefixedLog } from './Logger';
import { Config } from './Config';
import { UnrecoverableError } from './Constants';
import { IQueueMetrics, Metrics } from './Metrics';

const log = prefixedLog('MailQueue');

export class MailQueue
{
    /** While true, no files from the queue folder will be processed */
    #paused = false;
    #rootPath: string;
    #tempPath: string;
    #queuePath: string;
    #failedPath: string;
    #watcher: chokidar.FSWatcher|undefined;
    /** Remember mails to retry. Key = filename */
    #retryQueue = new Map<string, {retryAfter: Date, retryCount: number}>();
    #retryQueueInterval: NodeJS.Timeout|undefined;
    #correlationIdByFilename = new Map<string, string>();
    /** Prevent multiple retries from running simultaneous */
    #retryMutex = new Mutex();

    /**
     * Create a mail queue
     * @param rootPath Path where the queue, temp and failed folders are located/created
     */
    constructor(rootPath: string = Config.queueRootPath)
    {
        this.#paused = Config.mode === 'receive';
        this.#rootPath = rootPath;
        this.#tempPath = path.join(rootPath, 'temp');
        this.#queuePath = path.join(rootPath, 'queue');
        this.#failedPath = path.join(rootPath, 'failed');
        this.#ensureFolderStructure();
        Metrics.setQueueMetricsProvider(this.getMetrics.bind(this));
        this.#startWatcher();
    }

    get tempPath(): string
    {
        return this.#tempPath;
    }

    /** Return true when the configured persistent storage threshold is reached. */
    isAtOrAboveRejectThreshold(): boolean
    {
        if(!Config.queueMaxBytes) return false;
        return this.#storageUsageBytes(this.#rootPath) >= (Config.queueMaxBytes * Config.queueRejectThresholdPercent / 100);
    }

    getMetrics(): IQueueMetrics
    {
        const queued = this.#directoryMetrics(this.#queuePath);
        const failed = this.#directoryMetrics(this.#failedPath);
        return {
            queuedMessages: queued.files,
            queuedBytes: queued.bytes,
            failedMessages: failed.files,
            failedBytes: failed.bytes,
            storageBytes: this.#storageUsageBytes(this.#rootPath),
            storageRejectThresholdBytes: Config.queueMaxBytes?Math.floor(Config.queueMaxBytes*Config.queueRejectThresholdPercent/100):0,
        };
    }

    async close(): Promise<void>
    {
        if(this.#retryQueueInterval)
        {
            clearInterval(this.#retryQueueInterval);
            this.#retryQueueInterval = undefined;
        }
        await this.#watcher?.close();
    }

    #startWatcher()
    {
        if(this.#paused) return; // Don't start the watcher when it's paused

        this.#watcher = chokidar.watch(path.join(this.#queuePath, '*.eml'));
        this.#watcher.on('error', (error)=>{
            log('error', 'queue_watcher_error', {error});
        });
        this.#watcher.on('add', this.#onFileAdded.bind(this));
    }

    async #onFileAdded(filePath: string)
    {
        const filename = path.basename(filePath);
        const correlationId = this.#correlationIdByFilename.get(filename) ?? randomUUID();
        log('verbose', 'queue_delivery_started', {correlationId});
        
        try {
            const startedAt = Date.now();
            await Mailer.sendEml(filePath);
            this.remove(filePath);
            this.#removeFromRetryQueue(filename);
            Metrics.deliverySucceeded((Date.now()-startedAt)/1000);
        } catch(error) {
            Metrics.deliveryFailed();
            log('error', 'queue_delivery_failed', {error, correlationId});
            if(error instanceof UnrecoverableError)
                this.#moveToFailed(filename, error, correlationId);
            else
            {
                Metrics.deliveryRetried();
                this.#addToRetryQueue(filename, correlationId);
            }
        }
    }

    /** Atomically remove a permanent failure from the live queue. */
    #moveToFailed(filename: string, sendError: UnrecoverableError, correlationId: string)
    {
        try {
            fs.renameSync(path.join(this.#queuePath, filename), path.join(this.#failedPath, filename));
            this.#removeFromRetryQueue(filename);
            this.#correlationIdByFilename.delete(filename);
            log('error', 'queue_message_moved_to_failed', {error: sendError, correlationId});
        } catch(error) {
            log('error', 'queue_move_to_failed_error', {error, correlationId});
        }
    }

    #addToRetryQueue(filename: string, correlationId: string)
    {
        if(Config.sendRetryLimit) // Retrying is enabled?
        {
            const data = this.#retryQueue.get(filename);
            if(data && data.retryCount >= Config.sendRetryLimit) // This file is already in the queue and exceeded the retry limit?
            {
                try {
                    this.#retryQueue.delete(filename); // Remove from queue
                    fs.renameSync(path.join(this.#queuePath, filename), path.join(this.#failedPath, filename)); // Move to failed dir
                } catch(error) {
                    this.#correlationIdByFilename.delete(filename);
                    log('error', 'queue_retry_exhausted_move_failed', {error, correlationId});
                }
            }
            else // This file should be retried
            {
                const retryAfter = new Date();
                retryAfter.setMinutes(retryAfter.getMinutes()+Config.sendRetryInterval);
                this.#retryQueue.set(filename, {retryAfter, retryCount: (data?.retryCount || 0)+1});
            }

            // Start/stop the queue if necessary
            this.#startStopRetryQueue();
        }
    }

    #removeFromRetryQueue(filename: string)
    {
        if(this.#retryQueue.has(filename)) // Was this file in the retry queue?
        {
            this.#retryQueue.delete(filename);
            this.#startStopRetryQueue(); // Stop the queue if it's empty
        }
    }

    /** Start the retry queue if it's not already started and it's not empty */
    #startStopRetryQueue()
    {
        if(!this.#retryQueueInterval && this.#retryQueue.size > 0) // The queue is not started, but there are items waiting?
            this.#retryQueueInterval = setInterval(this.#retry.bind(this), 30000); // Fire retry every 30 seconds
        else if(this.#retryQueueInterval && this.#retryQueue.size === 0) // The queue is started, but it's empty?
        {
            clearInterval(this.#retryQueueInterval);
            this.#retryQueueInterval = undefined;
        }
    }

    async #retry()
    {
        if(this.#retryQueue.size === 0) return;
        if(this.#retryMutex.isLocked()) return; // Skip if it's already retrying

        await this.#retryMutex.runExclusive(async ()=>{
            for(const [filename,data] of this.#retryQueue)
            {
                if(data.retryAfter.getTime() < Date.now()) // This item should be retried?
                    await this.#onFileAdded(path.join(this.#queuePath, filename));
            }
        });
    }

    /**
     * Atomically enqueue a closed EML file and make both the file and queue
     * directory durable before the SMTP success boundary is crossed.
     */
    add(filePath: string, correlationId: string): Promise<void>
    {
        const filename = path.basename(filePath);
        const dest = path.join(this.#queuePath, filename);

        return new Promise((resolve, reject)=>{
            const attempt = (tries = 0) => {
                try {
                    fs.renameSync(filePath, dest);
                    this.#correlationIdByFilename.set(filename, correlationId);

                    const fileDescriptor = fs.openSync(dest, 'r');
                    try {
                        fs.fsyncSync(fileDescriptor);
                    } finally {
                        fs.closeSync(fileDescriptor);
                    }

                    const directoryDescriptor = fs.openSync(this.#queuePath, 'r');
                    try {
                        fs.fsyncSync(directoryDescriptor);
                    } finally {
                        fs.closeSync(directoryDescriptor);
                    }

                    log('verbose', 'queue_message_durably_enqueued', {correlationId});
                    resolve();
                } catch(error: any) {
                    // On Windows the file may still be locked for a brief moment after
                    // the stream closes. Retry a bounded number of times before
                    // returning a temporary SMTP failure to the sender.
                    if(error.code === 'EPERM' && process.platform === 'win32' && tries < 5) {
                        log('warn', 'queue_enqueue_retry', {correlationId});
                        setTimeout(() => attempt(tries + 1), 100);
                    } else {
                        log('error', 'queue_enqueue_error', {error, correlationId});
                        reject(error);
                    }
                }
            };

            attempt();
        });
    }

    remove(filePath: string)
    {
        try {
            fs.unlinkSync(filePath);
        } catch(error) {
            log('error', 'queue_delete_error', {error});
        }
    }

    #ensureFolderStructure()
    {
        if(!this.#pathExists(this.#rootPath)?.isDirectory())
            fs.mkdirSync(this.#rootPath);

        if(!this.#pathExists(this.#tempPath)?.isDirectory())
            fs.mkdirSync(this.#tempPath);

        if(!this.#pathExists(this.#queuePath)?.isDirectory())
            fs.mkdirSync(this.#queuePath);

        if(!this.#pathExists(this.#failedPath)?.isDirectory())
            fs.mkdirSync(this.#failedPath, {mode: 0o700});
        fs.chmodSync(this.#failedPath, 0o700);
    }

    #pathExists(path: string)
    {
        try {
            return fs.statSync(path);
        } catch(error: any) {
            if(!('code' in error) || error.code !== 'ENOENT')
                throw error;
        }
    }

    #storageUsageBytes(rootPath: string): number
    {
        let total = 0;
        for(const entry of fs.readdirSync(rootPath, {withFileTypes: true}))
        {
            const entryPath = path.join(rootPath, entry.name);
            if(entry.isDirectory())
                total += this.#storageUsageBytes(entryPath);
            else if(entry.isFile())
                total += fs.statSync(entryPath).size;
        }
        return total;
    }

    #directoryMetrics(directoryPath: string): {files: number, bytes: number}
    {
        let files = 0;
        let bytes = 0;
        for(const entry of fs.readdirSync(directoryPath, {withFileTypes: true}))
        {
            if(!entry.isFile() || !entry.name.endsWith('.eml')) continue;
            files++;
            bytes += fs.statSync(path.join(directoryPath, entry.name)).size;
        }
        return {files, bytes};
    }
}
