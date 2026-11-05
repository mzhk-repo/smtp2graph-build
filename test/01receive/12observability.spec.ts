import http from 'http';
import { expect } from 'chai';
import '../_config';
import { Server } from '../classes/Server';

function get(path: string): Promise<{statusCode: number|undefined, body: string}>
{
    return new Promise((resolve, reject)=>{
        http.get({host: '127.0.0.1', port: 1338, path}, response=>{
            let body = '';
            response.on('data', chunk=>{ body += chunk.toString(); });
            response.on('end', ()=>resolve({statusCode: response.statusCode, body}));
        }).on('error', reject);
    });
}

describe('Receive: observability signals', function(){
    const server = new Server({
        mode: 'receive',
        observability: {listenAddress: '127.0.0.1', port: 1338},
    });

    before('Start server', async function(){
        await server.start();
    });

    after('Stop server', async function(){
        await server.stop();
    });

    it('exposes liveness, readiness and bounded metrics', async function(){
        const liveness = await get('/livez');
        const readiness = await get('/readyz');
        const metrics = await get('/metrics');

        expect(liveness.statusCode).to.equal(200);
        expect(liveness.body).to.equal('ok\n');
        expect(readiness.statusCode).to.equal(200);
        expect(readiness.body).to.equal('ready\n');
        expect(metrics.statusCode).to.equal(200);
        expect(metrics.body).to.include('smtp2graph_smtp_sessions_active');
        expect(metrics.body).to.include('smtp2graph_queue_messages{state="queued"}');
        expect(metrics.body).to.not.include('recipient');
        expect(metrics.body).to.not.include('client_ip');
    });
});
