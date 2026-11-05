import { expect } from 'chai';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

describe('MailQueue: permanent failure and durable enqueue', ()=>{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp2graph-queue-'));
    const configPath = path.join(root, 'config.yml');
    const configArg = `--config=${configPath}`;
    let MailQueue: typeof import('../../src/classes/MailQueue').MailQueue;
    let Mailer: typeof import('../../src/classes/Mailer').Mailer;
    let MailboxAccessDenied: typeof import('../../src/classes/Mailer').MailboxAccessDenied;
    let Config: typeof import('../../src/classes/Config').Config;
    let Metrics: typeof import('../../src/classes/Metrics').Metrics;

    before(async ()=>{
        fs.writeFileSync(configPath, [
            'mode: full',
            'send:',
            '  appReg:',
            '    id: test-client',
            '    tenant: test-tenant',
            '    secret: test-secret',
        ].join('\n'));
        process.argv.push(configArg);
        (globalThis as any).DEBUG = false;
        ({MailQueue} = require('../../src/classes/MailQueue'));
        ({Mailer, MailboxAccessDenied} = require('../../src/classes/Mailer'));
        ({Config} = require('../../src/classes/Config'));
        ({Metrics} = require('../../src/classes/Metrics'));
    });

    after(()=>{
        process.argv.splice(process.argv.indexOf(configArg), 1);
        fs.rmSync(root, {recursive: true, force: true});
    });

    it('fsyncs the queued file and queue directory before resolving enqueue', async ()=>{
        const queue = new MailQueue(path.join(root, 'durable'));
        const source = path.join(queue.tempPath, 'message.eml');
        fs.writeFileSync(source, 'From: sender@example.test\r\n\r\nbody');

        const originalFsync = fs.fsyncSync;
        let fsyncCalls = 0;
        fs.fsyncSync = ((fd: number) => {
            fsyncCalls++;
            return originalFsync(fd);
        }) as typeof fs.fsyncSync;
        try {
            await queue.add(source, 'durable-test');
        } finally {
            fs.fsyncSync = originalFsync;
            await queue.close();
        }

        expect(fsyncCalls).to.equal(2);
        expect(fs.existsSync(path.join(root, 'durable', 'queue', 'message.eml'))).to.equal(true);
    });

    async function waitFor(condition: ()=>boolean)
    {
        for(let i = 0; i < 100 && !condition(); i++) await new Promise(resolve=>setTimeout(resolve, 20));
        expect(condition()).to.equal(true);
    }

    function deliveryCounts()
    {
        const report = Metrics.render();
        return Object.fromEntries(['succeeded', 'retry', 'failed'].map(result=>[
            result, Number(report.match(new RegExp(`smtp2graph_delivery_attempts_total\\{result="${result}"\\} (\\d+)`))![1]),
        ]));
    }

    it('releases the correlation ID after delivery and after an external removal', async ()=>{
        const queue = new MailQueue(path.join(root, 'correlation-success'));
        const originalSet = Map.prototype.set;
        const originalSend = Mailer.sendEml;
        const originalUnlink = fs.unlinkSync;
        let correlations: Map<string, string>|undefined;
        Map.prototype.set = function(key: any, value: any) {
            if(value === 'correlation-success') correlations = this as Map<string, string>;
            return originalSet.call(this, key, value);
        };
        Mailer.sendEml = async ()=>{};
        try {
            const source = path.join(queue.tempPath, 'success.eml');
            fs.writeFileSync(source, 'message');
            await queue.add(source, 'correlation-success');
            await waitFor(()=>!!correlations && !correlations.has('success.eml'));

            const failedSource = path.join(queue.tempPath, 'unlink-failure.eml');
            const queued = path.join(root, 'correlation-success', 'queue', 'unlink-failure.eml');
            fs.unlinkSync = ((file: fs.PathLike) => {
                if(String(file) === queued) throw new Error('synthetic unlink failure');
                return originalUnlink(file);
            }) as typeof fs.unlinkSync;
            fs.writeFileSync(failedSource, 'message');
            await queue.add(failedSource, 'correlation-success');
            await new Promise(resolve=>setTimeout(resolve, 250));
            expect(correlations?.has('unlink-failure.eml')).to.equal(true);
            originalUnlink(queued);
            await waitFor(()=>!correlations!.has('unlink-failure.eml'));
        } finally {
            Map.prototype.set = originalSet;
            Mailer.sendEml = originalSend;
            fs.unlinkSync = originalUnlink;
            await queue.close();
        }
    });

    it('does not retain correlation IDs in receive-only mode', async ()=>{
        const mode = Object.getOwnPropertyDescriptor(Config, 'mode')!;
        const originalSet = Map.prototype.set;
        let retained = false;
        Object.defineProperty(Config, 'mode', {configurable: true, get: ()=>'receive'});
        Map.prototype.set = function(key: any, value: any) {
            if(value === 'receive-only-correlation') retained = true;
            return originalSet.call(this, key, value);
        };
        const queue = new MailQueue(path.join(root, 'receive-only'));
        try {
            const source = path.join(queue.tempPath, 'receive.eml');
            fs.writeFileSync(source, 'message');
            await queue.add(source, 'receive-only-correlation');
            expect(retained).to.equal(false);
        } finally {
            Map.prototype.set = originalSet;
            Object.defineProperty(Config, 'mode', mode);
            await queue.close();
        }
    });

    for(const moveFails of [false, true])
    {
        it(`handles correlation ID when retry-exhausted move ${moveFails ? 'fails' : 'succeeds'}`, async ()=>{
            const limit = Object.getOwnPropertyDescriptor(Config, 'sendRetryLimit')!;
            const interval = Object.getOwnPropertyDescriptor(Config, 'sendRetryInterval')!;
            const originalSet = Map.prototype.set;
            const originalInterval = global.setInterval;
            const originalSend = Mailer.sendEml;
            const originalRename = fs.renameSync;
            const queueRoot = path.join(root, `retry-${moveFails}`);
            let correlations: Map<string, string>|undefined;
            let retry: (()=>void)|undefined;
            let attempts = 0;
            Object.defineProperty(Config, 'sendRetryLimit', {configurable: true, get: ()=>1});
            Object.defineProperty(Config, 'sendRetryInterval', {configurable: true, get: ()=>-1});
            Map.prototype.set = function(key: any, value: any) {
                if(value === 'retry-correlation') correlations = this as Map<string, string>;
                return originalSet.call(this, key, value);
            };
            global.setInterval = ((callback: any, delay: number, ...args: any[])=>{
                if(delay === 30000) retry = callback;
                return originalInterval(callback, delay, ...args);
            }) as typeof setInterval;
            Mailer.sendEml = async ()=>{ attempts++; throw new Error('synthetic delivery failure'); };
            fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike)=>{
                if(moveFails && String(newPath) === path.join(queueRoot, 'failed', 'retry.eml')) throw new Error('synthetic move failure');
                return originalRename(oldPath, newPath);
            }) as typeof fs.renameSync;
            const queue = new MailQueue(queueRoot);
            try {
                const before = deliveryCounts();
                const source = path.join(queue.tempPath, 'retry.eml');
                fs.writeFileSync(source, 'message');
                await queue.add(source, 'retry-correlation');
                await waitFor(()=>attempts === 1 && !!retry);
                expect(deliveryCounts()).to.deep.equal({...before, retry: before.retry + 1});
                retry!();
                await waitFor(()=>attempts === 2);
                expect(deliveryCounts()).to.deep.equal({...before, retry: before.retry + 1, failed: before.failed + 1});
                expect(correlations?.has('retry.eml')).to.equal(moveFails);
                expect(fs.existsSync(path.join(queueRoot, moveFails ? 'queue' : 'failed', 'retry.eml'))).to.equal(true);
            } finally {
                Map.prototype.set = originalSet;
                global.setInterval = originalInterval;
                Mailer.sendEml = originalSend;
                fs.renameSync = originalRename;
                Object.defineProperty(Config, 'sendRetryLimit', limit);
                Object.defineProperty(Config, 'sendRetryInterval', interval);
                await queue.close();
            }
        });
    }

    it('counts a transient failure followed by successful delivery', async ()=>{
        const interval = Object.getOwnPropertyDescriptor(Config, 'sendRetryInterval')!;
        const originalInterval = global.setInterval;
        const originalSend = Mailer.sendEml;
        let retry: (()=>void)|undefined;
        let attempts = 0;
        Object.defineProperty(Config, 'sendRetryInterval', {configurable: true, get: ()=>-1});
        global.setInterval = ((callback: any, delay: number, ...args: any[])=>{
            if(delay === 30000) retry = callback;
            return originalInterval(callback, delay, ...args);
        }) as typeof setInterval;
        Mailer.sendEml = async ()=>{ if(++attempts === 1) throw new Error('transient failure'); };
        const queue = new MailQueue(path.join(root, 'retry-success'));
        try {
            const before = deliveryCounts();
            const source = path.join(queue.tempPath, 'recovered.eml');
            fs.writeFileSync(source, 'message');
            await queue.add(source, 'recovered-correlation');
            await waitFor(()=>attempts === 1 && !!retry);
            retry!();
            await waitFor(()=>deliveryCounts().succeeded === before.succeeded + 1);
            expect(deliveryCounts()).to.deep.equal({...before, retry: before.retry + 1, succeeded: before.succeeded + 1});
        } finally {
            global.setInterval = originalInterval;
            Object.defineProperty(Config, 'sendRetryInterval', interval);
            Mailer.sendEml = originalSend;
            await queue.close();
        }
    });

    it('counts a failure without retry when retries are disabled', async ()=>{
        const limit = Object.getOwnPropertyDescriptor(Config, 'sendRetryLimit')!;
        const originalSend = Mailer.sendEml;
        Object.defineProperty(Config, 'sendRetryLimit', {configurable: true, get: ()=>0});
        Mailer.sendEml = async ()=>{ throw new Error('synthetic delivery failure'); };
        const queue = new MailQueue(path.join(root, 'retry-disabled'));
        try {
            const before = deliveryCounts();
            const source = path.join(queue.tempPath, 'disabled.eml');
            fs.writeFileSync(source, 'message');
            await queue.add(source, 'disabled-correlation');
            await waitFor(()=>deliveryCounts().failed === before.failed + 1);
            expect(deliveryCounts()).to.deep.equal({...before, failed: before.failed + 1});
            expect(fs.existsSync(path.join(root, 'retry-disabled', 'queue', 'disabled.eml'))).to.equal(true);
        } finally {
            Object.defineProperty(Config, 'sendRetryLimit', limit);
            Mailer.sendEml = originalSend;
            await queue.close();
        }
    });

    it('moves an unrecoverable delivery error from queue to failed', async ()=>{
        const queueRoot = path.join(root, 'permanent');
        const queue = new MailQueue(queueRoot);
        const filename = 'permanent.eml';
        const originalSendEml = Mailer.sendEml;
        Mailer.sendEml = async ()=>{
            throw new MailboxAccessDenied('denied');
        };

        try {
            const before = deliveryCounts();
            fs.writeFileSync(path.join(queueRoot, 'queue', filename), 'From: sender@example.test\r\n\r\nbody');
            await waitFor(()=>fs.existsSync(path.join(queueRoot, 'failed', filename)));
            expect(deliveryCounts()).to.deep.equal({...before, failed: before.failed + 1});
            expect(fs.existsSync(path.join(queueRoot, 'failed', filename))).to.equal(true);
            expect(fs.existsSync(path.join(queueRoot, 'queue', filename))).to.equal(false);
        } finally {
            Mailer.sendEml = originalSendEml;
            await queue.close();
        }
    });
});
