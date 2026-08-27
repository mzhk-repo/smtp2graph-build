import fs from 'fs';
import { X509Certificate } from 'crypto';

export interface IQueueMetrics
{
    queuedMessages: number;
    queuedBytes: number;
    failedMessages: number;
    failedBytes: number;
    storageBytes: number;
    storageRejectThresholdBytes: number;
}

/**
 * Small bounded in-process metrics registry. It deliberately has no labels
 * derived from SMTP clients, messages or mailbox data.
 */
export class Metrics
{
    static readonly #startTimeSeconds = Math.floor(Date.now()/1000);
    static #activeSessions = 0;
    static #smtpAccepted = 0;
    static #smtpRejected = 0;
    static #authAccepted = 0;
    static #authRejected = 0;
    static #deliverySucceeded = 0;
    static #deliveryRetried = 0;
    static #deliveryFailed = 0;
    static #deliveryDurationSeconds = 0;
    static #deliveryDurationCount = 0;
    static #tlsCertificateNotAfterSeconds: number|undefined;
    static #queueMetrics: ()=>IQueueMetrics = ()=>({
        queuedMessages: 0,
        queuedBytes: 0,
        failedMessages: 0,
        failedBytes: 0,
        storageBytes: 0,
        storageRejectThresholdBytes: 0,
    });

    static setQueueMetricsProvider(provider: ()=>IQueueMetrics)
    {
        this.#queueMetrics = provider;
    }

    static sessionOpened() { this.#activeSessions++; }
    static sessionClosed() { this.#activeSessions = Math.max(0, this.#activeSessions-1); }
    static smtpSubmissionAccepted() { this.#smtpAccepted++; }
    static smtpSubmissionRejected() { this.#smtpRejected++; }
    static smtpAuthAccepted() { this.#authAccepted++; }
    static smtpAuthRejected() { this.#authRejected++; }
    static deliverySucceeded(durationSeconds: number)
    {
        this.#deliverySucceeded++;
        this.#deliveryDurationCount++;
        this.#deliveryDurationSeconds += Math.max(0, durationSeconds);
    }
    static deliveryRetried() { this.#deliveryRetried++; }
    static deliveryFailed() { this.#deliveryFailed++; }
    static setTlsCertificateNotAfterSeconds(value: number|undefined) { this.#tlsCertificateNotAfterSeconds = value; }

    static render(): string
    {
        const queue = this.#queueMetrics();
        const lines = [
            '# HELP smtp2graph_process_start_time_seconds Unix time when the gateway process started.',
            '# TYPE smtp2graph_process_start_time_seconds gauge',
            `smtp2graph_process_start_time_seconds ${this.#startTimeSeconds}`,
            '# HELP smtp2graph_smtp_sessions_active Currently active SMTP sessions.',
            '# TYPE smtp2graph_smtp_sessions_active gauge',
            `smtp2graph_smtp_sessions_active ${this.#activeSessions}`,
            '# HELP smtp2graph_smtp_submissions_total SMTP DATA outcomes.',
            '# TYPE smtp2graph_smtp_submissions_total counter',
            `smtp2graph_smtp_submissions_total{result="accepted"} ${this.#smtpAccepted}`,
            `smtp2graph_smtp_submissions_total{result="rejected"} ${this.#smtpRejected}`,
            '# HELP smtp2graph_smtp_auth_total SMTP authentication outcomes.',
            '# TYPE smtp2graph_smtp_auth_total counter',
            `smtp2graph_smtp_auth_total{result="accepted"} ${this.#authAccepted}`,
            `smtp2graph_smtp_auth_total{result="rejected"} ${this.#authRejected}`,
            '# HELP smtp2graph_delivery_attempts_total Graph delivery outcomes.',
            '# TYPE smtp2graph_delivery_attempts_total counter',
            `smtp2graph_delivery_attempts_total{result="succeeded"} ${this.#deliverySucceeded}`,
            `smtp2graph_delivery_attempts_total{result="retry"} ${this.#deliveryRetried}`,
            `smtp2graph_delivery_attempts_total{result="failed"} ${this.#deliveryFailed}`,
            '# HELP smtp2graph_delivery_duration_seconds Graph delivery duration.',
            '# TYPE smtp2graph_delivery_duration_seconds summary',
            `smtp2graph_delivery_duration_seconds_sum ${this.#deliveryDurationSeconds}`,
            `smtp2graph_delivery_duration_seconds_count ${this.#deliveryDurationCount}`,
            '# HELP smtp2graph_queue_messages Persistent queue payload count.',
            '# TYPE smtp2graph_queue_messages gauge',
            `smtp2graph_queue_messages{state="queued"} ${queue.queuedMessages}`,
            `smtp2graph_queue_messages{state="failed"} ${queue.failedMessages}`,
            '# HELP smtp2graph_queue_bytes Persistent queue payload bytes.',
            '# TYPE smtp2graph_queue_bytes gauge',
            `smtp2graph_queue_bytes{state="queued"} ${queue.queuedBytes}`,
            `smtp2graph_queue_bytes{state="failed"} ${queue.failedBytes}`,
            '# HELP smtp2graph_storage_bytes Persistent storage usage.',
            '# TYPE smtp2graph_storage_bytes gauge',
            `smtp2graph_storage_bytes ${queue.storageBytes}`,
            '# HELP smtp2graph_storage_reject_threshold_bytes Configured storage rejection threshold.',
            '# TYPE smtp2graph_storage_reject_threshold_bytes gauge',
            `smtp2graph_storage_reject_threshold_bytes ${queue.storageRejectThresholdBytes}`,
        ];
        if(this.#tlsCertificateNotAfterSeconds !== undefined)
        {
            lines.push('# HELP smtp2graph_tls_certificate_not_after_seconds SMTP TLS certificate expiry as a Unix timestamp.');
            lines.push('# TYPE smtp2graph_tls_certificate_not_after_seconds gauge');
            lines.push(`smtp2graph_tls_certificate_not_after_seconds ${this.#tlsCertificateNotAfterSeconds}`);
        }
        return `${lines.join('\n')}\n`;
    }

    static certificateNotAfterSeconds(certificatePath: string|undefined): number|undefined
    {
        if(!certificatePath || !fs.existsSync(certificatePath)) return undefined;
        try
        {
            const certificate = new X509Certificate(fs.readFileSync(certificatePath));
            const expiry = Date.parse(certificate.validTo);
            return Number.isFinite(expiry)?Math.floor(expiry/1000):undefined;
        }
        catch
        {
            return undefined;
        }
    }
}
